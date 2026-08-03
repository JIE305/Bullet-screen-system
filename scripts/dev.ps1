$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$pnpm = Get-DaMuPnpm -Root $root
$env:DAMU_PYTHON = Join-Path $root 'backend\.venv\Scripts\python.exe'
$env:DAMU_BACKEND_ROOT = Join-Path $root 'backend'
$env:ELECTRON_EXEC_PATH = Join-Path $root 'desktop\node_modules\electron\dist\electron.exe'

Push-Location (Join-Path $root 'desktop')
try {
    & $pnpm dev
    if ($LASTEXITCODE -ne 0) { throw 'Desktop development process failed.' }
}
finally {
    Pop-Location
}
