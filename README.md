# Claudio

A small always-on-top window (plus a tray icon) that records what the Claude
and Codex desktop apps say out loud, so Read aloud replies become clips you can
scrub, rewind, skip and save.

Windows 11 only (it uses process loopback capture, added in Windows 11). Needs [Node.js](https://nodejs.org) and
[Python 3](https://www.python.org) (no extra Python packages).

**First time:**

```
npm install
```

Then right-click `make-shortcut.ps1` and choose **Run with PowerShell**. It puts
a **Claudio** shortcut on your desktop and in the Start menu. After that, just
double-click Claudio (or type "Claudio" in Start).

From a terminal you can also run `npm start`.

**Updates:** two ways to hear about new versions, both opt-in.

- On GitHub, click **Watch → Custom → Releases** on this repo. GitHub emails you
  when a new version is released.
- In Claudio, right-click the tray icon and tick **Notify me of updates**. Claudio
  then asks GitHub for the latest release once a day (nothing else is sent). When
  there is a newer one, a bar appears with **Update**, which runs `git pull` and
  `npm install` in the Claudio folder and restarts. If you downloaded a ZIP
  instead of cloning, Update opens the release page so you can download it.

Clips live in `%APPDATA%\claudio\clips` (WAV, 48 kHz mono, plus `index.json`).
Tray icon: click to show or hide; right-click for the clips folder and Quit.

## What it does (MVP)

- **Records Claude and Codex, nothing else.** Captures each app's own audio
  (Windows process loopback), not the whole system. Each app is recorded
  separately, and each clip in the list shows which app it came from. The apps
  still play to your normal speakers exactly as before; if Claudio is closed,
  nothing changes.
  - **Claude desktop:** recording, naming and the play/pause controls below.
  - **Codex desktop** (its program is `ChatGPT.exe`):
    recording only. Press Read aloud in Codex yourself; the clip is named
    "Codex audio" plus the time, and you can rename it. Codex hides its page
    from Windows' accessibility tools, so Claudio can't press its buttons or
    read the thread name. Its clips need 2.5 s of sound, so its 1.4 s
    notification chime is ignored.
- **Splits into clips.** A clip starts when the app makes sound and ends after
  3 s of quiet. Anything under 0.8 s of sound (chimes, clicks) is thrown away.
  Clips are named after the thread (session) that was reading plus the start of
  the reply (up to 60 characters), and the file is saved as
  `<thread> - <reply> <date> <time>.wav`, e.g.
  `Website redesign - Launching three background agents for the content work… 2026-11-10 18-43-18.wav`.
  The reply text is Claude's own "Claude responded: …" label for that message.
  Renaming a clip in the list renames its file too (the timestamp stays).
- **Your own playhead.** Play, pause, -10 / +10, drag on the waveform, or
  Space and the arrow keys, all while Claude keeps playing and the recording
  keeps growing. "Live" jumps to the newest audio.
- **Drives Claude.** "Read latest reply" presses Read aloud on the newest reply
  in the chosen window; "⏯ Claude" pauses or resumes Claude's own playback.
  While Claude is paused from Claudio, the clip stays open instead of ending.
- **Listen in Claudio (🎧).** Claude and Codex play silently in the
  background (Claudio turns them down to 0.1% in the Windows volume mixer) and
  you hear them through Claudio instead, about a quarter second behind. New
  clips start playing on their own. Pause in Claudio only pauses what you hear:
  the app keeps reading and the recording gets the whole reply. Play carries on
  where you stopped; Live catches up. Their volume goes back when you turn it
  off or quit Claudio. Muting the app instead would silence the recording too;
  0.1% doesn't, because Claudio records it as float and boosts it back up (with
  a limiter, since Windows' own one doesn't kick in at that volume).
- **Compact view (▭ / ▢).** Just the session name, waveform and player
  buttons, in a small window. Both settings are remembered.
- **Save** copies the WAV to wherever you choose (Downloads by default).

## How it works

| Piece | Job |
| --- | --- |
| `capture.py` | Python + ctypes, calls `ActivateAudioInterfaceAsync` with `VAD\Process_Loopback` for one app's main process and its children, and streams 48 kHz mono PCM to stdout. On `quiet 1` / `quiet 0` (stdin) it sets the app's mixer volume for Listen in Claudio. |
| `main.js` | Electron main: finds each app (the `APPS` list), runs one capture per app, cuts clips, writes WAVs, tray and window, and the opt-in update check. |
| `index.html` | The window: player, waveform and clip list. Plays clips through Web Audio. |
| `claude-control.ps1` | UI Automation: finds and presses Claude's Read aloud / Pause / Resume buttons. |

Why Python for capture: Smart App Control on this PC blocks newly compiled
unsigned `.exe` files (a Rust version was built first and was blocked). The
signed Python interpreter can call the same Windows API through ctypes.

**Safety rule in `claude-control.ps1`:** it only presses buttons inside a
reply's "Message actions" toolbar. Claude windows contain other buttons with
the same names. In the first test, an unscoped "Stop" press hit a session's own
Stop button instead of Read aloud's, so the restriction is deliberate.

## What we learned about Claude's Read aloud

- It is server-side text to speech. Each press opens a fresh WebSocket to
  `/api/ws/text_to_speech/text_stream` with the voice (default "buttery"),
  speed, and format (`opus_48000_32` or `pcm_16000`). Audio chunks play as they
  arrive. Nothing is written to disk, and playing a reply twice downloads it
  twice.
- There is an hourly limit on how much it will read.

### The "primed" player

The primed player is a warm, empty audio player. It never holds audio.

- Setting up playback is slow: an `AudioContext`, a gain node, an analyser, an
  AudioWorklet with a shared ring buffer (or a fallback that schedules
  buffers), and for Opus a WebCodecs `AudioDecoder`.
- When a read finishes, Claude does not throw that player away. It stops it,
  which clears its buffers, suspends its `AudioContext`, and "parks" it as
  `primed`.
- On the next Read aloud press, `takePrimed()` reuses it if the output format
  matches (otherwise it disposes it and builds a new one). That is why a second
  press starts faster. The text still goes to the server and new audio comes
  back.

What it could still give us: the player has an `AnalyserNode` and a single
point where every decoded chunk passes through, which is the cleanest place to
get perfect audio and word timing. Reaching it means running code inside
Claude's page (for example through the Chrome DevTools Protocol, if Claude
allows a debugging port). That is fragile and not something to rely on, so the
MVP records from the outside instead.

## Known limits / next steps

- Records in real time; the hourly Read aloud limit still applies.
- Other Claude sounds (voice mode, longer chimes) can become clips.
- If a reply's "Claude responded" label has scrolled out of Claude's
  accessibility tree, the name falls back to the reply's last visible block of
  text, so it can be a mid-reply line.
- Share: today it is Save as WAV. Next: MP3/Opus export and a share link.
- Codex is record-only (see above). Its replies also have no pause, only
  Stop and Replay.
- Codex voice chat and other Codex sounds longer than 2.5 s become clips too.
- Listen in Claudio: when a read starts, the app's first ~0.1 s can be heard at
  normal volume before Claudio turns it down (apps only open an audio stream
  while playing). It works on the default output device only.
- If Claudio crashes with Listen on, its recorders notice and put Claude and
  Codex back to their normal volume.
- Speed control (1.25x, 1.5x) is not in yet.

## Releasing

`main` is what users run. After a merge to `main`, bump `version` in
`package.json` (in the PR), then tag and publish a GitHub Release named
`vX.Y.Z` with short notes. Watchers get an email and Claudio users with
**Notify me of updates** on see the Update bar.

## License

MIT. See [LICENSE](LICENSE).
