// Claudio: records what Claude desktop and Codex say out loud (Read aloud) into
// clips you can scrub, save and share. Capture runs in capture.py (WASAPI process
// loopback), one per app; Claude's buttons are driven by claude-control.ps1 (UI Automation).
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, screen } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const RATE = 48000;
const BLOCK = 960; // 20 ms of mono samples
const START_RMS = 250; // int16 RMS that counts as sound
const END_SILENCE_MS = 3000; // silence that ends a clip
const MIN_SOUND_MS = 800; // shorter clips (chimes, clicks) are discarded

// Apps Claudio listens to. Each is matched by process name and install folder, and
// recorded on its own. Codex hides its page from UI Automation, so it is record-only.
const APPS = [
  { name: 'Claude', exe: 'claude.exe', path: '*\\WindowsApps\\Claude_*' },
  // The Codex desktop app (ChatGPT.exe; installed as OpenAI.Codex, older installs as OpenAI.ChatGPT).
  // Its notification chime is 1.4 s long.
  { name: 'Codex', exe: 'ChatGPT.exe', path: '*\\WindowsApps\\OpenAI.*', minSoundMs: 2500 },
];
const FULL_SIZE = { width: 380, height: 560 };
const COMPACT_SIZE = { width: 380, height: 132 };
const KEEP_TAIL_MS = 500;
const PREROLL_BLOCKS = 10;

// Electron's GPU library (libEGL.dll) is blocked by Smart App Control on this PC
// and triggers a Windows Security popup. This window doesn't need the GPU.
app.disableHardwareAcceleration();

const clipsDir = path.join(app.getPath('userData'), 'clips');
const indexFile = path.join(clipsDir, 'index.json');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
fs.mkdirSync(clipsDir, { recursive: true });

// listen: "Listen in Claudio" (the apps play quietly, Claudio plays the audio).
// compact: the small window with only the player.
// updates: check GitHub once a day for a newer release (off until the user turns it on).
let settings = { listen: false, compact: false, updates: false };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch {}
function saveSettings() { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); }

let win = null;
let tray = null;
let clips = loadIndex();
// Per app: { name, pid, capture, carry, preroll, cur (clip being recorded), state }
const sources = APPS.map((a) => ({ ...a, pid: null, capture: null, carry: Buffer.alloc(0), preroll: [], cur: null, state: 'waiting' }));
let lastWindowTitle = null; // window we last asked to read
let lastThread = null; // its thread name and reply, for naming the next clip
let claudeHeld = false; // we paused Claude, so silence should not end its clip

function loadIndex() {
  let list;
  try { list = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return []; }
  // Older clips were saved as <id>.wav; give them readable names once.
  let changed = false;
  for (const m of list) {
    if (m.app === 'ChatGPT') { m.app = 'Codex'; changed = true; } // briefly labelled ChatGPT
    if (m.file === `${m.id}.wav`) {
      const name = renameClipFile(m.file, clipFileName(m.title, m.startedAt));
      if (name !== m.file) { m.file = name; changed = true; }
    }
  }
  if (changed) fs.writeFileSync(indexFile, JSON.stringify(list, null, 2));
  return list;
}

// "<thread> - <reply> 2026-11-10 17-16-05.wav", safe for Windows file names.
function clipFileName(title, startedAt) {
  const d = new Date(startedAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const safe = String(title || 'Claude audio').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150).replace(/[. ]+$/, '') || 'Claude audio';
  return `${safe} ${stamp}.wav`;
}

// Clip title: the thread, plus the start of the reply being read ("Thread - First words of the reply…").
function clipTitle(thread, reply) {
  let r = String(reply || '').replace(/\s+/g, ' ').trim().replace(/[.:,;!?]+$/, '');
  if (r.length > 60) r = r.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  return thread && r ? `${thread} - ${r}` : (thread || r || null);
}

// Renames a clip file inside clipsDir, avoiding collisions. Returns the name actually used.
function renameClipFile(from, to) {
  if (from === to) return from;
  let name = to;
  for (let i = 2; fs.existsSync(path.join(clipsDir, name)); i++) name = to.replace(/\.wav$/, ` (${i}).wav`);
  try { fs.renameSync(path.join(clipsDir, from), path.join(clipsDir, name)); return name; } catch { return from; }
}
function saveIndex() { fs.writeFileSync(indexFile, JSON.stringify(clips, null, 2)); }
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function status(text) { send('status', text); }
function showListening() {
  const on = sources.filter((s) => s.state === 'on').map((s) => s.name);
  status(on.length ? `Listening to ${on.join(' and ')}` : 'Waiting for Claude or Codex to start…');
}
function liveClips() { return sources.filter((s) => s.cur).map((s) => s.cur); }

// ---------- capture ----------
function findPid(src) {
  return new Promise((resolve) => {
    // The app's root process: the one whose parent is not another copy of it.
    const ps = `$p=Get-CimInstance Win32_Process -Filter "Name='${src.exe}'" | ? { $_.ExecutablePath -like '${src.path}' }; $ids=$p.ProcessId; ($p | ? { $ids -notcontains $_.ParentProcessId } | select -First 1).ProcessId`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err, out) => {
      const pid = parseInt(String(out).trim(), 10);
      resolve(Number.isFinite(pid) ? pid : null);
    });
  });
}

async function startCapture(src) {
  if (app.isQuitting) return;
  const pid = await findPid(src);
  if (!pid) { src.state = 'waiting'; showListening(); setTimeout(() => startCapture(src), 5000); return; }
  src.pid = pid;
  // detached: Node otherwise puts children in a job that Windows kills with Claudio,
  // and capture.py must outlive a crash long enough to put the app's volume back.
  // It still exits on its own when Claudio's end of stdin closes.
  src.capture = spawn('python', ['-I', path.join(__dirname, 'capture.py'), String(pid)], { windowsHide: true, detached: true });
  src.capture.stdout.on('data', (chunk) => onPcm(src, chunk));
  src.capture.stderr.on('data', (d) => console.log(`[capture ${src.name}]`, String(d).trim()));
  src.capture.stdin.on('error', () => {});
  if (settings.listen) src.capture.stdin.write('quiet 1\n');
  src.capture.on('exit', () => {
    src.capture = null;
    src.state = 'waiting';
    finishClip(src);
    showListening();
    setTimeout(() => startCapture(src), 3000);
  });
  src.state = 'on';
  showListening();
}

function onPcm(src, chunk) {
  const buf = src.carry.length ? Buffer.concat([src.carry, chunk]) : chunk;
  const blockBytes = BLOCK * 2;
  let off = 0;
  for (; off + blockBytes <= buf.length; off += blockBytes) {
    onBlock(src, Buffer.from(buf.subarray(off, off + blockBytes)));
  }
  src.carry = Buffer.from(buf.subarray(off));
}

function rms(block) {
  let s = 0;
  for (let i = 0; i < block.length; i += 2) { const v = block.readInt16LE(i); s += v * v; }
  return Math.sqrt(s / (block.length / 2));
}

function onBlock(src, block) {
  const loud = rms(block) > START_RMS;
  const now = Date.now();
  const cur = src.cur;
  if (!cur) {
    src.preroll.push(block);
    if (src.preroll.length > PREROLL_BLOCKS) src.preroll.shift();
    if (loud) startClip(src, now);
    return;
  }
  if (loud) {
    cur.lastLoud = now;
    cur.soundBlocks++;
    for (const b of cur.pending) writeBlock(cur, b); // silence inside speech is kept
    cur.pending = [];
    writeBlock(cur, block);
  } else {
    cur.pending.push(block);
    const held = src.name === 'Claude' && claudeHeld;
    if (!held && now - cur.lastLoud > END_SILENCE_MS) finishClip(src);
  }
}

function startClip(src, now) {
  const id = `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${src.name.toLowerCase()}`;
  // Recorded under a temporary name; renamed to "<title> <date time>.wav" when it finishes.
  const file = path.join(clipsDir, `${id}.recording.wav`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, wavHeader(0));
  const title = src.name === 'Claude' ? (lastThread || lastWindowTitle || 'Claude audio') : `${src.name} audio`;
  const cur = src.cur = { id, app: src.name, file, fd, samples: 0, startedAt: now, lastLoud: now, soundBlocks: 0, pending: [], title };
  send('clip-start', { id, app: src.name, title, startedAt: now, live: true });
  for (const b of src.preroll) writeBlock(cur, b);
  src.preroll = [];
  if (src.name !== 'Claude') return;
  // Name the clip after the Claude thread and reply that is reading, if we can tell.
  control('windows').then((r) => {
    // Just after a press, Claude can still report the old state, so "paused" counts too.
    const playing = r && r.ok && (r.windows.find((w) => w.state === 'playing') || r.windows.find((w) => w.state === 'paused'));
    const t = playing && clipTitle(playing.thread || playing.title, playing.reply);
    if (t && src.cur === cur) { cur.title = t; send('clip-title', { id, title: t }); }
  });
}

function writeBlock(cur, b) {
  fs.writeSync(cur.fd, b);
  cur.samples += b.length / 2;
  send('clip-data', { id: cur.id, pcm: b });
}

function finishClip(src) {
  const c = src.cur;
  if (!c) return;
  src.cur = null;
  const tail = Math.floor((KEEP_TAIL_MS / 1000) * RATE / BLOCK);
  for (const b of c.pending.slice(0, tail)) writeBlock(c, b);
  const header = wavHeader(c.samples * 2);
  fs.writeSync(c.fd, header, 0, header.length, 0);
  fs.closeSync(c.fd);
  if (c.soundBlocks * BLOCK / RATE * 1000 < (src.minSoundMs || MIN_SOUND_MS)) {
    fs.rmSync(c.file, { force: true });
    send('clip-discard', { id: c.id });
    return;
  }
  const file = renameClipFile(path.basename(c.file), clipFileName(c.title, c.startedAt));
  const meta = { id: c.id, app: c.app, title: c.title, startedAt: c.startedAt, duration: c.samples / RATE, file };
  clips.unshift(meta);
  saveIndex();
  send('clip-end', meta);
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

// ---------- Claude control ----------
function control(action, windowTitle) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'claude-control.ps1'), '-Action', action];
    if (windowTitle) args.push('-Window', windowTitle);
    execFile('powershell', args, { windowsHide: true, timeout: 20000 }, (err, out) => {
      try { resolve(JSON.parse(String(out).trim().split('\n').pop())); }
      catch { resolve({ ok: false, error: err ? err.message : 'No answer from Claude control' }); }
    });
  });
}

ipcMain.handle('claude', async (_e, action, windowTitle) => {
  if (action === 'read') { lastWindowTitle = windowTitle || null; lastThread = null; }
  const r = await control(action, windowTitle);
  if (r.ok && action === 'read') {
    lastThread = clipTitle(r.thread || r.window, r.reply);
    const cur = sources[0].cur;
    if (cur && lastThread && cur.title === 'Claude audio') { cur.title = lastThread; send('clip-title', { id: cur.id, title: lastThread }); }
  }
  if (r.ok && action === 'toggle') claudeHeld = r.did === 'Pause';
  if (action === 'read') claudeHeld = false;
  return r;
});

// ---------- clips ----------
ipcMain.handle('clips', () => ({ clips, live: liveClips().map((c) => ({ id: c.id, app: c.app, title: c.title, startedAt: c.startedAt })) }));
ipcMain.handle('clip-pcm', (_e, id) => {
  if (liveClips().some((c) => c.id === id)) return null; // live clips stream in instead
  const meta = clips.find((c) => c.id === id);
  if (!meta) return null;
  return fs.readFileSync(path.join(clipsDir, meta.file)).subarray(44);
});
ipcMain.handle('save-clip', async (_e, id) => {
  const meta = clips.find((c) => c.id === id);
  if (!meta) return false;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), clipFileName(meta.title, meta.startedAt)),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (canceled || !filePath) return false;
  fs.copyFileSync(path.join(clipsDir, meta.file), filePath);
  shell.showItemInFolder(filePath);
  return true;
});
ipcMain.handle('reveal-clip', (_e, id) => {
  const meta = clips.find((c) => c.id === id);
  if (meta) shell.showItemInFolder(path.join(clipsDir, meta.file));
});
ipcMain.handle('rename-clip', (_e, id, title) => {
  const meta = clips.find((c) => c.id === id);
  if (meta && title.trim()) {
    meta.title = title.trim();
    meta.file = renameClipFile(meta.file, clipFileName(meta.title, meta.startedAt));
    saveIndex();
  }
});
ipcMain.handle('delete-clip', (_e, id) => {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  fs.rmSync(path.join(clipsDir, clips[i].file), { force: true });
  clips.splice(i, 1);
  saveIndex();
});
ipcMain.on('hide', () => win && win.hide());
ipcMain.handle('settings', () => settings);
ipcMain.handle('set-listen', (_e, on) => {
  settings.listen = !!on;
  saveSettings();
  for (const src of sources) if (src.capture) src.capture.stdin.write(`quiet ${on ? 1 : 0}\n`);
  return settings;
});
ipcMain.handle('set-compact', (_e, on) => {
  settings.compact = !!on;
  saveSettings();
  // Keep the window's bottom edge where it is, so it shrinks toward the corner.
  const b = win.getBounds(), size = on ? COMPACT_SIZE : FULL_SIZE;
  win.setBounds({ x: b.x, y: b.y + b.height - size.height, width: b.width, height: size.height });
  return settings;
});

// ---------- updates (opt-in) ----------
// When "Notify me of updates" is on, Claudio asks GitHub for the latest release once a
// day. Nothing is sent except that request. Update = git pull + npm install + restart.
const REPO = 'MrMalkio/claudio';
const RELEASES = `https://github.com/${REPO}/releases`;
let update = null; // { version, url } of a newer release
let updateTimer = null;

function newer(a, b) { // is version a newer than b?
  const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function checkUpdates() {
  if (!settings.updates) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { 'User-Agent': 'Claudio', Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = await r.json();
    if (newer(rel.tag_name, app.getVersion())) {
      update = { version: rel.tag_name.replace(/^v/, ''), url: rel.html_url };
      send('update', update);
    }
  } catch {}
}

function setUpdates(on) {
  settings.updates = !!on;
  saveSettings();
  clearInterval(updateTimer);
  if (settings.updates) { checkUpdates(); updateTimer = setInterval(checkUpdates, 24 * 3600 * 1000); }
  else { update = null; send('update', null); }
  buildTrayMenu();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd: __dirname, windowsHide: true, timeout: 300000 },
    (err, _out, errOut) => (err ? reject(new Error((errOut || err.message).trim().split(/\r?\n/)[0])) : resolve())));
}

ipcMain.handle('update-info', () => update);
ipcMain.handle('run-update', async () => {
  // A downloaded copy (no .git folder) can't pull: send the user to the release page.
  if (!fs.existsSync(path.join(__dirname, '.git'))) { shell.openExternal(update?.url || RELEASES); return { ok: true, opened: true }; }
  try {
    send('update-status', 'Downloading the update…');
    // npm can rewrite the lockfile on install; drop that so the pull isn't blocked by it.
    await run('git', ['checkout', '--', 'package-lock.json']);
    await run('git', ['pull', '--ff-only']);
    send('update-status', 'Installing…');
    await run('cmd.exe', ['/d', '/c', 'npm', 'install', '--no-audit', '--no-fund']);
    send('update-status', 'Restarting…');
    app.relaunch();
    app.quit();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Update failed: ${e.message}` };
  }
});
ipcMain.on('open-release', () => shell.openExternal(update?.url || RELEASES));

// ---------- window + tray ----------
function trayIcon() {
  const size = 32;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5);
    const bar = Math.abs(x - 15.5) < 7 && [8, 11, 15, 19, 22].some((bx) => Math.abs(x - bx) < 1.2) &&
      Math.abs(y - 15.5) < [5, 8, 10, 8, 5][[8, 11, 15, 19, 22].findIndex((bx) => Math.abs(x - bx) < 1.2)];
    const i = (y * size + x) * 4;
    if (d < 15) {
      const [b, g, r] = bar ? [255, 255, 255] : [87, 119, 217];
      px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const size = settings.compact ? COMPACT_SIZE : FULL_SIZE;
  win = new BrowserWindow({
    ...size, x: workArea.x + workArea.width - size.width - 20, y: workArea.y + workArea.height - size.height - 20,
    minWidth: 300, minHeight: COMPACT_SIZE.height,
    frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: '#16171d', title: 'Claudio', icon: trayIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') console.log('[ui]', e.message); });
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggleWindow },
    { label: 'Open clips folder', click: () => shell.openPath(clipsDir) },
    { type: 'separator' },
    { label: 'Notify me of updates', type: 'checkbox', checked: settings.updates, click: (m) => setUpdates(m.checked) },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit Claudio', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function toggleWindow() {
  if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
}

app.whenReady().then(() => {
  createWindow();
  tray = new Tray(trayIcon());
  tray.setToolTip('Claudio');
  tray.on('click', toggleWindow);
  buildTrayMenu();
  setUpdates(settings.updates);
  for (const src of sources) startCapture(src);
  // Dev aid: CLAUDIO_SNAPSHOT=<file.png> saves a picture of the window after it settles.
  if (process.env.CLAUDIO_SNAPSHOT) {
    setTimeout(() => win.webContents.executeJavaScript("document.querySelector('.clip')?.click()"), 4000);
    setTimeout(async () => fs.writeFileSync(process.env.CLAUDIO_SNAPSHOT, (await win.webContents.capturePage()).toPNG()), 6000);
  }
});

app.on('before-quit', (e) => {
  app.isQuitting = true;
  const running = sources.filter((s) => s.capture);
  for (const src of sources) finishClip(src);
  if (!running.length) return;
  // Let each capture put its app's volume back before Claudio goes.
  e.preventDefault();
  let left = running.length;
  const done = () => { if (--left === 0) app.exit(0); };
  for (const src of running) { src.capture.once('exit', done); src.capture.stdin.end(); src.capture = null; }
  setTimeout(() => app.exit(0), 3000);
});
app.on('window-all-closed', (e) => e.preventDefault());
