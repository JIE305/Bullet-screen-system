$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Resolve-Pnpm {
    $localPnpm = Join-Path $root '.tools\node_modules\.bin\pnpm.cmd'
    if (Test-Path -LiteralPath $localPnpm) { return $localPnpm }

    $existing = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
    if ($existing) { return $existing.Source }

    $npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw 'Node.js/npm was not found. Install Node.js 24, reopen PowerShell, then run setup again.'
    }
    $toolsDir = Join-Path $root '.tools'
    $npmCache = Join-Path $root '.runtime\npm-cache'
    New-Item -ItemType Directory -Force $toolsDir, $npmCache | Out-Null
    Write-Host 'pnpm was not found; installing a project-local pnpm 11.9.0...' -ForegroundColor Yellow
    & $npm.Source install --prefix $toolsDir --cache $npmCache --no-save --no-audit --no-fund 'pnpm@11.9.0' | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to install project-local pnpm. See the npm error above.'
    }
    if (-not (Test-Path -LiteralPath $localPnpm)) {
        throw 'npm completed but the project-local pnpm executable was not created.'
    }
    return $localPnpm
}

$pnpm = Resolve-Pnpm

Push-Location (Join-Path $root 'backend')
try {
    if (-not (Test-Path '.venv')) {
        py -3.12 -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create Python 3.12 virtual environment.' }
    }
    & '.\.venv\Scripts\python.exe' -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'Failed to upgrade pip.' }
    & '.\.venv\Scripts\python.exe' -m pip install -e '.[dev]'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install backend dependencies.' }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $root 'desktop')
try {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    & $pnpm install
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install desktop dependencies.' }
    $electronExe = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electronExe)) {
        throw 'Electron binary is incomplete. Re-run setup with ELECTRON_MIRROR configured.'
    }
}
finally {
    Pop-Location
}

Write-Host 'DaMuSystem dependencies are ready.' -ForegroundColor Green
