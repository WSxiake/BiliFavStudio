# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules
from pathlib import Path
import sys
sys.path.insert(0, str(Path(SPECPATH) / 'tools'))
from release_assets import web_paths

hiddenimports = ['bilifav.vendor.qrcodegen']
hiddenimports += collect_submodules('bilifav')


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[(str(p), str(Path('bilifav/web') / p.relative_to(Path(SPECPATH) / 'bilifav/web').parent))
           for p in web_paths(Path(SPECPATH))] + [('bilifav/data', 'bilifav/data'),
           ('assets/icon.ico', 'assets'), ('assets/icon.png', 'assets')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='BiliFav Studio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['assets/icon.ico'],
    version='assets/windows-version.txt',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='BiliFav Studio',
)
