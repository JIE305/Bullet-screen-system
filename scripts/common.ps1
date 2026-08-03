function Get-DaMuPnpm {
    param([Parameter(Mandatory = $true)][string]$Root)

    $localPnpm = Join-Path $Root '.tools\node_modules\.bin\pnpm.cmd'
    if (Test-Path -LiteralPath $localPnpm) { return $localPnpm }

    $systemPnpm = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
    if ($systemPnpm) { return $systemPnpm.Source }

    throw 'pnpm is unavailable. Run .\scripts\setup.ps1 first.'
}
