$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$pnpm = Get-DaMuPnpm -Root $root

Push-Location (Join-Path $root 'backend')
try {
    & '.\.venv\Scripts\python.exe' -m pytest
    if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $root 'desktop')
try {
    & $pnpm typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Desktop typecheck failed.' }
    & $pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed.' }
    & $pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
}
finally {
    Pop-Location
}
