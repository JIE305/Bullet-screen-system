$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$pnpm = Get-DaMuPnpm -Root $root

Push-Location (Join-Path $root 'backend')
try {
    & '.\.venv\Scripts\python.exe' -m PyInstaller --noconfirm --clean 'damusystem-backend.spec'
    if ($LASTEXITCODE -ne 0) { throw 'Backend packaging failed.' }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $root 'desktop')
$previousBuilderMirror = $env:ELECTRON_BUILDER_BINARIES_MIRROR
try {
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    }
    & $pnpm package:win
    if ($LASTEXITCODE -ne 0) { throw 'Electron packaging failed.' }
}
finally {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = $previousBuilderMirror
    Pop-Location
}
