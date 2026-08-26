# 拡張機能を配布用zipに固める（Chromeウェブストア申請 / 社内配布用）
# 使い方: リポジトリルートで powershell -File scripts/package-agent.ps1
param([string]$OutDir = "dist")

$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content (Join-Path $root "agent/manifest.json") -Raw | ConvertFrom-Json
$zip = Join-Path $root "$OutDir/chrome-edr-agent-$($manifest.version).zip"

New-Item -ItemType Directory -Force (Join-Path $root $OutDir) | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $root "agent/*") -DestinationPath $zip
Write-Output "created: $zip"
