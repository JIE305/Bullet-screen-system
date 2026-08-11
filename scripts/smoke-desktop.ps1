param(
    [ValidateSet('dummy', 'rapidocr')]
    [string]$Recognizer = 'dummy',
    [switch]$Packaged
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$pnpm = Get-DaMuPnpm -Root $root
$desktop = Join-Path $root 'desktop'
$runtime = Join-Path $root '.runtime'
$resultPath = Join-Path $runtime 'automated-desktop-smoke.json'
$smokeUserData = Join-Path $runtime 'automated-desktop-user-data'
$electronPath = if ($Packaged) {
    Join-Path $desktop 'release\win-unpacked\DaMuSystem.exe'
} else {
    Join-Path $desktop 'node_modules\electron\dist\electron.exe'
}

New-Item -ItemType Directory -Force $runtime | Out-Null
if (Test-Path -LiteralPath $resultPath) {
    Remove-Item -LiteralPath $resultPath -Force
}

Push-Location $desktop
try {
    if (-not $Packaged) {
        & $pnpm build | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
    } elseif (-not (Test-Path -LiteralPath $electronPath)) {
        throw "Packaged desktop not found: $electronPath"
    }

    $env:DAMU_AUTOMATED_DEMO = '1'
    $env:DAMU_AUTOMATED_RESULT = $resultPath
    if (-not $Packaged) {
        $env:DAMU_PYTHON = Join-Path $root 'backend\.venv\Scripts\python.exe'
        $env:DAMU_BACKEND_ROOT = Join-Path $root 'backend'
    }
    $env:DAMU_RECOGNIZER = $Recognizer
    $arguments = if ($Packaged) { @("--user-data-dir=$smokeUserData") } else { @('.', "--user-data-dir=$smokeUserData") }
    Start-Process -FilePath $electronPath -ArgumentList $arguments -WorkingDirectory $desktop | Out-Null

    $deadline = (Get-Date).AddSeconds($(if ($Recognizer -eq 'rapidocr') { 60 } else { 30 }))
    while (-not (Test-Path -LiteralPath $resultPath) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-Path -LiteralPath $resultPath)) {
        throw 'Desktop smoke test timed out before receiving a danmaku event.'
    }

    $result = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultPath | ConvertFrom-Json
    if (
        $result.status -ne 'ok' -or
        $result.frames_accepted -lt 1 -or
        -not $result.overlay_visible -or
        -not $result.overlay_always_on_top -or
        $result.overlay_focusable -or
        -not $result.restart_verified -or
        -not $result.overlay_recreated -or
        -not $result.old_overlay_destroyed -or
        $result.old_message_count -lt 1 -or
        $result.new_message_count -lt 1 -or
        -not $result.live_style_applied -or
        -not $result.restarted_style_applied -or
        -not $result.danmaku_content_matches -or
        -not $result.application_menu_removed -or
        -not $result.control_menu_hidden -or
        -not $result.control_menu_hidden_after_alt -or
        -not $result.event_filter_verified -or
        -not $result.event_copy_verified -or
        -not $result.event_remove_verified -or
        -not $result.event_filtered_clear_verified -or
        -not $result.cloud_rail_fits_1100x720 -or
        -not $result.cloud_no_horizontal_overflow -or
        -not $result.cloud_drawer_scrollable -or
        -not $result.cloud_drawer_bottom_reachable -or
        -not $result.cloud_key_hidden_from_renderer -or
        -not $result.cloud_backdrop_blur_only -or
        -not $result.cloud_escape_focus_return -or
        -not $result.backend_crash_recovered
    ) {
        throw "Desktop smoke test failed: $($result | ConvertTo-Json -Compress)"
    }
    Write-Output "Desktop smoke passed: $($result | ConvertTo-Json -Compress)"
}
finally {
    Remove-Item Env:DAMU_AUTOMATED_DEMO -ErrorAction SilentlyContinue
    Remove-Item Env:DAMU_AUTOMATED_RESULT -ErrorAction SilentlyContinue
    Remove-Item Env:DAMU_RECOGNIZER -ErrorAction SilentlyContinue
    Remove-Item Env:DAMU_PYTHON -ErrorAction SilentlyContinue
    Remove-Item Env:DAMU_BACKEND_ROOT -ErrorAction SilentlyContinue
    Pop-Location
}
