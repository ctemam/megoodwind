@echo off
rem AllBright Cockpit launcher — idempotent: starts the dashboard server
rem only if :9205 is not already answering, then opens the UI.
cd /d C:\Users\op\Desktop\MyAllBright
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:9205/health).StatusCode -eq 200 } catch { $false }" | findstr /i "True" >nul
if errorlevel 1 (
  if not exist logs mkdir logs
  start "AllBright Dashboard" /min cmd /c "node apps\dashboard\server\index.js >> logs\dashboard.log 2>&1"
  timeout /t 2 /nobreak >nul
)
start "" http://localhost:9205
