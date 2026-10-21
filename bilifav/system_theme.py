"""Read the current Windows app accent without changing system settings."""
from __future__ import annotations

import os
import uuid
from typing import Any, Dict


def _ui_settings_accent() -> str:
    """UISettings.GetColorValue(UIColorType.Accent), using the WinRT ABI.

    The DWM glass color can be blended or stale and is not SystemAccentColor.
    Create/read/release on the calling HTTP thread; no cross-apartment objects.
    """
    import ctypes as c
    from ctypes import wintypes as w

    class Color(c.Structure):
        _fields_ = [(part, c.c_ubyte) for part in ("a", "r", "g", "b")]

    runtime = c.WinDLL("combase")
    runtime.RoInitialize.argtypes = [w.DWORD]
    runtime.RoInitialize.restype = c.c_long
    runtime.RoUninitialize.argtypes = []
    runtime.RoUninitialize.restype = None
    runtime.WindowsCreateString.argtypes = [w.LPCWSTR, w.UINT, c.POINTER(c.c_void_p)]
    runtime.WindowsCreateString.restype = c.c_long
    runtime.WindowsDeleteString.argtypes = [c.c_void_p]
    runtime.WindowsDeleteString.restype = c.c_long
    runtime.RoActivateInstance.argtypes = [c.c_void_p, c.POINTER(c.c_void_p)]
    runtime.RoActivateInstance.restype = c.c_long

    def check(hr: int) -> None:
        if hr < 0:
            raise OSError(f"WinRT HRESULT 0x{hr & 0xFFFFFFFF:08X}")

    def method(ptr, slot, result, *args):
        table = c.cast(ptr, c.POINTER(c.POINTER(c.c_void_p))).contents
        return c.WINFUNCTYPE(result, c.c_void_p, *args)(table[slot])

    hr = runtime.RoInitialize(1)  # RO_INIT_MULTITHREADED
    # A host may have already initialized the thread as STA. It is usable, but
    # must not be balanced by our RoUninitialize in that case.
    if hr < 0 and (hr & 0xFFFFFFFF) != 0x80010106:
        check(hr)
    name, instance, settings = c.c_void_p(), c.c_void_p(), c.c_void_p()
    try:
        class_name = "Windows.UI.ViewManagement.UISettings"
        check(runtime.WindowsCreateString(class_name, len(class_name), c.byref(name)))
        check(runtime.RoActivateInstance(name, c.byref(instance)))
        iid = (c.c_ubyte * 16).from_buffer_copy(uuid.UUID("03021be4-5254-4781-8194-5168f7d06d7b").bytes_le)
        check(method(instance, 0, c.c_long, c.c_void_p, c.POINTER(c.c_void_p))(
            instance, c.byref(iid), c.byref(settings)))
        color = Color()
        check(method(settings, 6, c.c_long, c.c_int, c.POINTER(Color))(
            settings, 5, c.byref(color)))
        return f"#{color.r:02X}{color.g:02X}{color.b:02X}"
    finally:
        for ptr in (settings, instance):
            if ptr:
                method(ptr, 2, w.ULONG)(ptr)  # IUnknown.Release
        if name:
            runtime.WindowsDeleteString(name)
        if hr >= 0:
            runtime.RoUninitialize()


def _registry_accent() -> str:
    """Fallback for Windows hosts where WinRT activation is unavailable."""
    import winreg

    for path, name in [
        (r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent", "AccentColorMenu"),
        (r"Software\Microsoft\Windows\DWM", "AccentColor"),
    ]:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
                value, kind = winreg.QueryValueEx(key, name)
            if kind == winreg.REG_DWORD and isinstance(value, int):
                # These registry values use 0xAABBGGRR, unlike DWM's glass API.
                return f"#{value & 255:02X}{value >> 8 & 255:02X}{value >> 16 & 255:02X}"
        except OSError:
            continue
    raise OSError("Windows accent is unavailable")


def system_theme() -> Dict[str, Any]:
    if os.name == "nt":
        for read, source in [(_ui_settings_accent, "ui-settings"), (_registry_accent, "registry")]:
            try:
                return {"ok": True, "accent": read(), "available": True, "source": source}
            except (OSError, AttributeError):
                continue
    return {"ok": True, "accent": None, "available": False, "source": None}
