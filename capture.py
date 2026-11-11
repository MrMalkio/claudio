"""claudio capture: record one Windows app's audio (and its child processes)
with WASAPI process loopback, without changing where that app plays.

Usage:  python capture.py <pid>
Output: raw mono 16-bit little-endian PCM at 48 kHz on stdout.
Stdin:  "quiet 1" turns the app down to QUIET in the Windows volume mixer, so you
        don't hear it, while the recording is boosted back to full volume
        (Claudio plays it instead). "quiet 0" puts the volume back.
Stops when stdin closes, so it dies with the app that started it, and puts the
app's volume back first.

Pure ctypes on purpose: Smart App Control blocks new unsigned .exe files on
this machine, but the signed Python interpreter can call the Windows API.
"""

import array
import ctypes
import sys
import threading
import time
from ctypes import POINTER, byref, c_uint16, c_uint32, c_uint64, c_void_p, wintypes

RATE = 48_000
# App volume while Claudio plays the audio instead: -60 dB, inaudible. The loopback
# stream is taken after the app's volume, so it is captured as float (no precision
# lost) and multiplied back up. Muting instead would silence the recording too.
QUIET = 0.001
HRESULT = ctypes.c_long


class GUID(ctypes.Structure):
    _fields_ = [("d1", c_uint32), ("d2", c_uint16), ("d3", c_uint16), ("d4", ctypes.c_ubyte * 8)]

    @classmethod
    def parse(cls, s):
        import uuid
        u = uuid.UUID(s)
        g = cls()
        ctypes.memmove(byref(g), u.bytes_le, 16)
        return g


IID_IUnknown = GUID.parse("00000000-0000-0000-C000-000000000046")
IID_IAgileObject = GUID.parse("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90")
IID_Handler = GUID.parse("41D949AB-9862-444A-80F6-C261334DA5EB")
IID_IAudioClient = GUID.parse("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")
IID_IAudioCaptureClient = GUID.parse("C8ADBD64-E71E-48a0-A4DE-185C395CD317")
CLSID_MMDeviceEnumerator = GUID.parse("BCDE0395-E52F-467C-8E3D-C4579291692E")
IID_IMMDeviceEnumerator = GUID.parse("A95664D2-9614-4F35-A746-DE8DB63617E6")
IID_IAudioSessionManager2 = GUID.parse("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")
IID_IAudioSessionControl2 = GUID.parse("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")
IID_ISimpleAudioVolume = GUID.parse("87CE5498-68D6-44E5-9215-6DA47EF883D8")


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wintypes.WORD), ("nChannels", wintypes.WORD),
        ("nSamplesPerSec", wintypes.DWORD), ("nAvgBytesPerSec", wintypes.DWORD),
        ("nBlockAlign", wintypes.WORD), ("wBitsPerSample", wintypes.WORD), ("cbSize", wintypes.WORD),
    ]


class ACTIVATION_PARAMS(ctypes.Structure):
    # AUDIOCLIENT_ACTIVATION_PARAMS with PROCESS_LOOPBACK params inline
    _fields_ = [("ActivationType", c_uint32), ("TargetProcessId", c_uint32), ("ProcessLoopbackMode", c_uint32)]


class BLOB(ctypes.Structure):
    _fields_ = [("cbSize", c_uint32), ("pBlobData", c_void_p)]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", c_uint16), ("r1", c_uint16), ("r2", c_uint16), ("r3", c_uint16), ("blob", BLOB)]


def vcall(obj, index, restype, *args, argtypes=()):
    """Call method `index` of a COM interface pointer."""
    vtbl = ctypes.cast(ctypes.cast(obj, POINTER(c_void_p))[0], POINTER(c_void_p))
    fn = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vtbl[index])
    return fn(obj, *args)


def check(hr, what):
    if hr < 0:
        raise OSError(f"{what} failed: 0x{hr & 0xFFFFFFFF:08X}")


# --- completion handler: a tiny COM object implemented in ctypes ---------------
QI_T = ctypes.WINFUNCTYPE(HRESULT, c_void_p, POINTER(GUID), POINTER(c_void_p))
REF_T = ctypes.WINFUNCTYPE(c_uint32, c_void_p)
DONE_T = ctypes.WINFUNCTYPE(HRESULT, c_void_p, c_void_p)


class Handler:
    def __init__(self):
        self.done = threading.Event()
        self.operation = None

        def qi(this, riid, ppv):
            if any(bytes(riid.contents) == bytes(g) for g in (IID_IUnknown, IID_Handler, IID_IAgileObject)):
                ppv[0] = this
                return 0
            ppv[0] = None
            return -2147467262  # E_NOINTERFACE

        def done(this, op):
            self.operation = op
            self.done.set()
            return 0

        self._fns = (QI_T(qi), REF_T(lambda this: 1), REF_T(lambda this: 1), DONE_T(done))
        self._vtbl = (c_void_p * 4)(*[ctypes.cast(f, c_void_p) for f in self._fns])
        self._obj = ctypes.pointer(ctypes.cast(self._vtbl, c_void_p))
        self.ptr = ctypes.cast(self._obj, c_void_p)


def open_loopback(pid):
    ole32 = ctypes.OleDLL("ole32")
    ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED

    params = ACTIVATION_PARAMS(1, pid, 0)  # PROCESS_LOOPBACK, INCLUDE_TARGET_PROCESS_TREE
    pv = PROPVARIANT(vt=65, blob=BLOB(ctypes.sizeof(params), ctypes.cast(byref(params), c_void_p)))
    handler = Handler()
    op = c_void_p()

    mmdev = ctypes.WinDLL("Mmdevapi")
    activate = mmdev.ActivateAudioInterfaceAsync
    activate.restype = HRESULT
    activate.argtypes = [wintypes.LPCWSTR, POINTER(GUID), POINTER(PROPVARIANT), c_void_p, POINTER(c_void_p)]
    check(activate("VAD\\Process_Loopback", byref(IID_IAudioClient), byref(pv), handler.ptr, byref(op)),
          "ActivateAudioInterfaceAsync")
    if not handler.done.wait(10):
        raise TimeoutError("audio activation timed out")

    hr, unk = HRESULT(), c_void_p()
    check(vcall(op, 3, HRESULT, byref(hr), byref(unk), argtypes=(POINTER(HRESULT), POINTER(c_void_p))),
          "GetActivateResult")
    check(hr.value, "activation")
    client = c_void_p()
    check(vcall(unk, 0, HRESULT, byref(IID_IAudioClient), byref(client),
                argtypes=(POINTER(GUID), POINTER(c_void_p))), "QueryInterface(IAudioClient)")

    fmt = WAVEFORMATEX(3, 1, RATE, RATE * 4, 4, 32, 0)  # float mono, made 16-bit on output
    flags = 0x00020000 | 0x80000000 | 0x08000000  # LOOPBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY
    check(vcall(client, 3, HRESULT, 0, flags, c_uint64(2_000_000), c_uint64(0), byref(fmt), None,
                argtypes=(c_uint32, c_uint32, c_uint64, c_uint64, POINTER(WAVEFORMATEX), c_void_p)),
          "IAudioClient.Initialize")
    cap = c_void_p()
    check(vcall(client, 14, HRESULT, byref(IID_IAudioCaptureClient), byref(cap),
                argtypes=(POINTER(GUID), POINTER(c_void_p))), "GetService(IAudioCaptureClient)")
    check(vcall(client, 10, HRESULT), "Start")
    return client, cap, handler


# --- the app's volume in the Windows mixer ------------------------------------
class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]


def process_tree(root):
    k32 = ctypes.WinDLL("kernel32")
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.Process32FirstW.argtypes = k32.Process32NextW.argtypes = [wintypes.HANDLE, POINTER(PROCESSENTRY32W)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k32.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
    parent = {}
    e = PROCESSENTRY32W()
    e.dwSize = ctypes.sizeof(e)
    ok = k32.Process32FirstW(snap, byref(e))
    while ok:
        parent[e.th32ProcessID] = e.th32ParentProcessID
        ok = k32.Process32NextW(snap, byref(e))
    k32.CloseHandle(snap)
    tree, grew = {root}, True
    while grew:
        grew = False
        for p, pp in parent.items():
            if pp in tree and p not in tree:
                tree.add(p)
                grew = True
    return tree


def release(obj):
    if obj.value:
        vcall(obj, 2, c_uint32)


def app_volumes(root):
    """[(ISimpleAudioVolume, level)] for each audio session of root's process tree on
    the default output device. The caller releases the volume objects."""
    ole32 = ctypes.OleDLL("ole32")
    tree = process_tree(root)
    found = []
    en, dev, mgr, sessions = c_void_p(), c_void_p(), c_void_p(), c_void_p()
    try:
        ole32.CoCreateInstance(byref(CLSID_MMDeviceEnumerator), None, 23, byref(IID_IMMDeviceEnumerator), byref(en))
        check(vcall(en, 4, HRESULT, 0, 0, byref(dev), argtypes=(c_uint32, c_uint32, POINTER(c_void_p))),
              "GetDefaultAudioEndpoint")
        check(vcall(dev, 3, HRESULT, byref(IID_IAudioSessionManager2), 23, None, byref(mgr),
                    argtypes=(POINTER(GUID), c_uint32, c_void_p, POINTER(c_void_p))), "Activate(SessionManager2)")
        check(vcall(mgr, 5, HRESULT, byref(sessions), argtypes=(POINTER(c_void_p),)), "GetSessionEnumerator")
        n = ctypes.c_int()
        vcall(sessions, 3, HRESULT, byref(n), argtypes=(POINTER(ctypes.c_int),))
        for i in range(n.value):
            ctl, ctl2 = c_void_p(), c_void_p()
            if vcall(sessions, 4, HRESULT, i, byref(ctl), argtypes=(ctypes.c_int, POINTER(c_void_p))) < 0:
                continue
            try:
                if vcall(ctl, 0, HRESULT, byref(IID_IAudioSessionControl2), byref(ctl2),
                         argtypes=(POINTER(GUID), POINTER(c_void_p))) < 0:
                    continue
                spid = c_uint32()
                vcall(ctl2, 14, HRESULT, byref(spid), argtypes=(POINTER(c_uint32),))
                if spid.value not in tree:
                    continue
                vol = c_void_p()
                if vcall(ctl, 0, HRESULT, byref(IID_ISimpleAudioVolume), byref(vol),
                         argtypes=(POINTER(GUID), POINTER(c_void_p))) < 0:
                    continue
                level = ctypes.c_float()
                vcall(vol, 4, HRESULT, byref(level), argtypes=(POINTER(ctypes.c_float),))
                found.append((vol, level.value))
            finally:
                release(ctl2)
                release(ctl)
    finally:
        for o in (sessions, mgr, dev, en):
            release(o)
    return found


class Mixer:
    """Keeps the app at QUIET while quiet mode is on (new audio sessions included),
    and owns the gain that turns the recording back up."""

    def __init__(self, pid):
        self.pid = pid
        self.want_quiet = False
        self.gain = 1.0
        self.saved = 1.0  # the app's own volume, put back afterwards
        self.lock = threading.Lock()
        self.wake = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()

    def quiet(self, on):
        with self.lock:
            self.want_quiet = on
            if not on:
                self.gain = 1.0  # before the volume comes back up, so nothing is over-boosted
        self.wake.set()

    def apply(self, quiet):
        """Sets every session of the app. Returns (changed, levels before)."""
        changed, levels = False, []
        for vol, level in app_volumes(self.pid):
            levels.append(level)
            try:
                if quiet and level > QUIET * 1.5:
                    self.saved = level
                    target = QUIET
                elif not quiet and abs(level - QUIET) < QUIET * 0.01:
                    # Also repairs an app left quiet by a Claudio that crashed.
                    target = self.saved if self.saved > QUIET * 1.5 else 1.0
                else:
                    continue
                vcall(vol, 3, HRESULT, ctypes.c_float(target), None, argtypes=(ctypes.c_float, c_void_p))
                changed = True
            finally:
                release(vol)
        return changed, levels

    def run(self):
        # Apps open an audio session only while they play, so a read can start at full
        # volume. The boost follows the volume the app is actually at, so the recording
        # is never over-boosted; it is checked 10 times a second while quiet mode is on.
        ctypes.OleDLL("ole32").CoInitializeEx(None, 0)
        while True:
            with self.lock:
                quiet = self.want_quiet
            try:
                changed, levels = self.apply(quiet)
                if changed and quiet:
                    time.sleep(0.15)  # let audio played at the old volume pass first
                loud = [lv for lv in levels if lv > QUIET * 1.5]
                with self.lock:
                    if not self.want_quiet or not levels:
                        self.gain = 1.0
                    elif changed or not loud:
                        self.gain = 1.0 / QUIET
                    else:
                        self.gain = 1.0 / max(loud)
            except OSError as e:
                print(f"volume: {e}", file=sys.stderr, flush=True)
            self.wake.wait(0.1 if quiet else 1.0)
            self.wake.clear()

    def restore(self):
        self.quiet(False)
        try:
            ctypes.OleDLL("ole32").CoInitializeEx(None, 0)
            self.apply(False)
        except OSError:
            pass


class Limiter:
    """At full volume Windows' own limiter keeps peaks under 1.0. At QUIET the app's
    audio never reaches it, so boosted peaks can go over (about 1.4x on speech).
    This does the same job: it turns a packet down just enough when its peak would
    clip, then eases back up over about a second."""

    def __init__(self):
        self.level = 1.0

    def process(self, raw, gain):
        f = array.array("f")
        f.frombytes(raw)
        peak = max(map(abs, f), default=0.0) * gain
        if peak * self.level > 0.98:
            self.level = 0.98 / peak
        g = gain * self.level
        out = array.array("h", [int(max(-1.0, min(1.0, x * g)) * 32767) for x in f])
        self.level = min(1.0, self.level * 1.01)
        return out.tobytes()


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: capture.py <pid>")
    pid = int(sys.argv[1])

    client, cap, _handler = open_loopback(pid)
    mixer = Mixer(pid)
    limiter = Limiter()

    def watch_stdin():
        try:
            for line in sys.stdin.buffer:
                cmd = line.decode(errors="ignore").split()
                if cmd[:1] == ["quiet"]:
                    mixer.quiet(cmd[1:2] == ["1"])
        finally:
            mixer.restore()
            import os
            os._exit(0)

    threading.Thread(target=watch_stdin, daemon=True).start()
    print(f"capturing pid {pid} at {RATE} Hz", file=sys.stderr, flush=True)
    out = sys.stdout.buffer
    data, frames, flags = c_void_p(), c_uint32(), c_uint32()
    pkt = c_uint32()
    argt_get = (POINTER(c_void_p), POINTER(c_uint32), POINTER(c_uint32), c_void_p, c_void_p)
    while True:
        time.sleep(0.01)
        check(vcall(cap, 5, HRESULT, byref(pkt), argtypes=(POINTER(c_uint32),)), "GetNextPacketSize")
        while pkt.value:
            check(vcall(cap, 3, HRESULT, byref(data), byref(frames), byref(flags), None, None, argtypes=argt_get),
                  "GetBuffer")
            n = frames.value
            if flags.value & 0x2:  # AUDCLNT_BUFFERFLAGS_SILENT
                out.write(bytes(n * 2))
            else:
                out.write(limiter.process(ctypes.string_at(data, n * 4), mixer.gain))
            vcall(cap, 4, HRESULT, frames.value, argtypes=(c_uint32,))
            check(vcall(cap, 5, HRESULT, byref(pkt), argtypes=(POINTER(c_uint32),)), "GetNextPacketSize")
        out.flush()


if __name__ == "__main__":
    main()
