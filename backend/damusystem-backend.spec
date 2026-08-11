from PyInstaller.utils.hooks import collect_data_files, collect_submodules

rapidocr_data = collect_data_files("rapidocr")
alembic_data = [("alembic", "alembic")]

analysis = Analysis(
    ["launcher.py"],
    pathex=["src"],
    binaries=[],
    datas=rapidocr_data + alembic_data,
    hiddenimports=collect_submodules("rapidocr") + [
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="damusystem-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)
collect = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=True,
    name="damusystem-backend",
)
