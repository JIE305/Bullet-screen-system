$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'smoke-desktop.ps1') -Recognizer rapidocr
