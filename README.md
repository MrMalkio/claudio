# Claudio

A small always-on-top window (plus a tray icon) that records what Claude desktop
says out loud, so Read aloud replies become clips you can scrub, rewind, skip
and save.

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

Clips live in `%APPDATA%\claudio\clips` (WAV, 48 kHz mono, plus `index.json`).
Tray icon: click to show or hide; right-click for the clips folder and Quit.

## What it does (MVP)

- **Records Claude only.** Captures the Claude app's own audio (Windows process
  loopback), not the whole system. Claude still plays to your normal speakers
  exactly as before; if Claudio is closed, nothing changes.
- **Splits into clips.** A clip starts when Claude makes sound and ends after
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
- **Save** copies the WAV to wherever you choose (Downloads by default).

## How it works

| Piece | Job |
| --- | --- |
| `capture.py` | Python + ctypes, calls `ActivateAudioInterfaceAsync` with `VAD\Process_Loopback` for Claude's main process and its children, and streams 48 kHz mono PCM to stdout. |
| `main.js` | Electron main: finds Claude, runs the capture, cuts clips, writes WAVs, tray and window. |
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
- Only the Claude desktop app is supported. Codex and ChatGPT desktop are not
  yet: `capture.py` takes any process id, so adding them is mostly picking the
  right process and button names.
- Untested: whether muting Claude in the Windows volume mixer also mutes the
  recording.
- Speed control (1.25x, 1.5x) is not in yet.
