# watchdog.ps1 — keeps the arb-runner alive on Windows (Task Scheduler).
# Register:  schtasks /create /tn "AllBrightWatchdog" /sc minute /mo 1 `
#            /tr "pwsh -File C:\Users\op\Desktop\MyAllBright\scripts\watchdog.ps1"
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$running = Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'arbRunner' }

if (-not $running) {
  $log = Join-Path $root 'data\runner.log'
  Start-Process -WindowStyle Hidden -FilePath 'npx' `
    -ArgumentList 'tsx src/runner/arbRunner.ts' `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Add-Content $log "$(Get-Date -Format o) watchdog: restarted arb-runner"
}
