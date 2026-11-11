// Claudio: records Claude desktop's audio (Read aloud) into clips you can scrub,
// save and share. Capture runs in capture.py (WASAPI process loopback);
// Claude's buttons are driven by claude-control.ps1 (UI Automation).
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, screen } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const RATE = 48000;
const BLOCK = 960; // 20 ms of mono samples
const START_RMS = 250; // int16 RMS that counts as sound
const END_SILENCE_MS = 3000; // silence that ends a clip
const MIN_SOUND_MS = 800; // shorter clips (chimes, clicks) are discarded
const KEEP_TAIL_MS = 500;
const PREROLL_BLOCKS = 10;

// Electron's GPU library (libEGL.dll) is blocked by Smart App Control on this PC
// and triggers a Windows Security popup. This window doesn't need the GPU.
app.disableHardwareAcceleration();

const clipsDir = path.join(app.getPath('userData'), 'clips');
const indexFile = path.join(clipsDir, 'index.json');
fs.mkdirSync(clipsDir, { recursive: true });

let win = null;
let tray = null;
let capture = null;
let capturePid = null;
let clips = loadIndex();
let cur = null; // clip being recorded
let carry = Buffer.alloc(0);
let preroll = [];
let lastWindowTitle = null; // window we last asked to read
let lastThread = null; // its thread name and reply, for naming the next clip
let claudeHeld = false; // we paused Claude, so silence should not end the clip

function loadIndex() {
  let list;
  try { list = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return []; }
  // Older clips were saved as <id>.wav; give them readable names once.
  let changed = false;
  for (const m of list) {
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

// ---------- capture ----------
function findClaudePid() {
  return new Promise((resolve) => {
    const ps = "$p=Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ? { $_.ExecutablePath -like '*\\WindowsApps\\Claude_*' }; $ids=$p.ProcessId; ($p | ? { $ids -notcontains $_.ParentProcessId } | select -First 1).ProcessId";
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err, out) => {
      const pid = parseInt(String(out).trim(), 10);
      resolve(Number.isFinite(pid) ? pid : null);
    });
  });
}

async function startCapture() {
  const pid = await findClaudePid();
  if (!pid) { status('Waiting for Claude to start…'); setTimeout(startCapture, 5000); return; }
  capturePid = pid;
  capture = spawn('python', ['-I', path.join(__dirname, 'capture.py'), String(pid)], { windowsHide: true });
  capture.stdout.on('data', onPcm);
  capture.stderr.on('data', (d) => console.log('[capture]', String(d).trim()));
  capture.on('exit', (code) => {
    capture = null;
    finishClip(true);
    status('Capture stopped, reconnecting…');
    setTimeout(startCapture, 3000);
  });
  status('Listening to Claude');
}

function onPcm(chunk) {
  let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  const blockBytes = BLOCK * 2;
  let off = 0;
  for (; off + blockBytes <= buf.length; off += blockBytes) {
    onBlock(Buffer.from(buf.subarray(off, off + blockBytes)));
  }
  carry = Buffer.from(buf.subarray(off));
}

function rms(block) {
  let s = 0;
  for (let i = 0; i < block.length; i += 2) { const v = block.readInt16LE(i); s += v * v; }
  return Math.sqrt(s / (block.length / 2));
}

function onBlock(block) {
  const loud = rms(block) > START_RMS;
  const now = Date.now();
  if (!cur) {
    preroll.push(block);
    if (preroll.length > PREROLL_BLOCKS) preroll.shift();
    if (loud) startClip(now);
    return;
  }
  if (loud) {
    cur.lastLoud = now;
    cur.soundBlocks++;
    for (const b of cur.pending) writeBlock(b); // silence inside speech is kept
    cur.pending = [];
    writeBlock(block);
  } else {
    cur.pending.push(block);
    if (!claudeHeld && now - cur.lastLoud > END_SILENCE_MS) finishClip(false);
  }
}

function startClip(now) {
  const id = new Date(now).toISOString().replace(/[:.]/g, '-');
  // Recorded under a temporary name; renamed to "<thread> <date time>.wav" when it finishes.
  const file = path.join(clipsDir, `${id}.recording.wav`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, wavHeader(0));
  cur = { id, file, fd, samples: 0, startedAt: now, lastLoud: now, soundBlocks: 0, pending: [],
          title: lastThread || lastWindowTitle || 'Claude audio' };
  send('clip-start', { id, title: cur.title, startedAt: now, live: true });
  for (const b of preroll) writeBlock(b);
  preroll = [];
  // Name the clip after the window that is reading, if we can tell.
  control('windows').then((r) => {
    const playing = r && r.ok && r.windows.find((w) => w.state === 'playing');
    const title = playing && clipTitle(playing.thread || playing.title, playing.reply);
    if (title && cur && cur.id === id) { cur.title = title; send('clip-title', { id, title }); }
  });
}

function writeBlock(b) {
  fs.writeSync(cur.fd, b);
  cur.samples += b.length / 2;
  send('clip-data', { id: cur.id, pcm: b });
}

function finishClip(force) {
  if (!cur) return;
  const c = cur;
  cur = null;
  const tail = Math.floor((KEEP_TAIL_MS / 1000) * RATE / BLOCK);
  for (const b of c.pending.slice(0, tail)) { fs.writeSync(c.fd, b); c.samples += b.length / 2; send('clip-data', { id: c.id, pcm: b }); }
  const header = wavHeader(c.samples * 2);
  fs.writeSync(c.fd, header, 0, header.length, 0);
  fs.closeSync(c.fd);
  if (c.soundBlocks * BLOCK / RATE * 1000 < MIN_SOUND_MS) {
    fs.rmSync(c.file, { force: true });
    send('clip-discard', { id: c.id });
    return;
  }
  const file = renameClipFile(path.basename(c.file), clipFileName(c.title, c.startedAt));
  const meta = { id: c.id, title: c.title, startedAt: c.startedAt, duration: c.samples / RATE, file };
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
    if (cur && lastThread && cur.title === 'Claude audio') { cur.title = lastThread; send('clip-title', { id: cur.id, title: lastThread }); }
  }
  if (r.ok && action === 'toggle') claudeHeld = r.did === 'Pause';
  if (action === 'read') claudeHeld = false;
  return r;
});

// ---------- clips ----------
ipcMain.handle('clips', () => ({ clips, live: cur ? { id: cur.id, title: cur.title, startedAt: cur.startedAt } : null }));
ipcMain.handle('clip-pcm', (_e, id) => {
  if (cur && cur.id === id) return null; // live clip streams in instead
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
  win = new BrowserWindow({
    width: 380, height: 560, x: workArea.x + workArea.width - 400, y: workArea.y + workArea.height - 580,
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

function toggleWindow() {
  if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
}

app.whenReady().then(() => {
  createWindow();
  tray = new Tray(trayIcon());
  tray.setToolTip('Claudio');
  tray.on('click', toggleWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggleWindow },
    { label: 'Open clips folder', click: () => shell.openPath(clipsDir) },
    { type: 'separator' },
    { label: 'Quit Claudio', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  startCapture();
  // Dev aid: CLAUDIO_SNAPSHOT=<file.png> saves a picture of the window after it settles.
  if (process.env.CLAUDIO_SNAPSHOT) {
    setTimeout(() => win.webContents.executeJavaScript("document.querySelector('.clip')?.click()"), 4000);
    setTimeout(async () => fs.writeFileSync(process.env.CLAUDIO_SNAPSHOT, (await win.webContents.capturePage()).toPNG()), 6000);
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  finishClip(true);
  if (capture) capture.stdin.end();
});
app.on('window-all-closed', (e) => e.preventDefault());
