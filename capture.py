"""claudio capture: record one Windows app's audio (and its child processes)
with WASAPI process loopback, without changing where that app plays.

Usage:  python capture.py <pid>
Output: raw mono 16-bit little-endian PCM at 48 kHz on stdout.
Stops when stdin closes, so it dies with the app that started it.

Pure ctypes on purpose: Smart App Control blocks new unsigned .exe files on
this machine, but the signed Python interpreter can call the Windows API.
"""

import ctypes
import sys
import threading
import time
from ctypes import POINTER, byref, c_uint16, c_uint32, c_uint64, c_void_p, wintypes

RATE = 48_000
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

    fmt = WAVEFORMATEX(1, 1, RATE, RATE * 2, 2, 16, 0)  # PCM mono 16-bit
    flags = 0x00020000 | 0x80000000 | 0x08000000  # LOOPBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY
    check(vcall(client, 3, HRESULT, 0, flags, c_uint64(2_000_000), c_uint64(0), byref(fmt), None,
                argtypes=(c_uint32, c_uint32, c_uint64, c_uint64, POINTER(WAVEFORMATEX), c_void_p)),
          "IAudioClient.Initialize")
    cap = c_void_p()
    check(vcall(client, 14, HRESULT, byref(IID_IAudioCaptureClient), byref(cap),
                argtypes=(POINTER(GUID), POINTER(c_void_p))), "GetService(IAudioCaptureClient)")
    check(vcall(client, 10, HRESULT), "Start")
    return client, cap, handler


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: capture.py <pid>")
    pid = int(sys.argv[1])

    def watch_stdin():
        try:
            while sys.stdin.buffer.read(64):
                pass
        finally:
            import os
            os._exit(0)

    threading.Thread(target=watch_stdin, daemon=True).start()

    client, cap, _handler = open_loopback(pid)
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
            n = frames.value * 2
            if flags.value & 0x2:  # AUDCLNT_BUFFERFLAGS_SILENT
                out.write(bytes(n))
            else:
                out.write(ctypes.string_at(data, n))
            vcall(cap, 4, HRESULT, frames.value, argtypes=(c_uint32,))
            check(vcall(cap, 5, HRESULT, byref(pkt), argtypes=(POINTER(c_uint32),)), "GetNextPacketSize")
        out.flush()


if __name__ == "__main__":
    main()
