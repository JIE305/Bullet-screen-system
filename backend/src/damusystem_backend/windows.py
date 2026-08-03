from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

from .contracts import WindowBounds


def get_window_bounds(hwnd: int) -> WindowBounds | None:
    """Return Win32 window bounds in desktop coordinates without touching game memory."""
    if sys.platform != "win32" or hwnd <= 0:
        return None

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL

    handle = wintypes.HWND(hwnd)
    if not user32.IsWindow(handle) or user32.IsIconic(handle):
        return None
    rect = wintypes.RECT()
    if not user32.GetWindowRect(handle, ctypes.byref(rect)):
        return None
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        return None
    return WindowBounds(x=rect.left, y=rect.top, width=width, height=height)
