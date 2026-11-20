@echo off
setlocal
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ytdl-ext.lnk"

if exist "%LINK%" (
  del /f /q "%LINK%"
  echo [REMOVED] %LINK%
) else (
  echo [SKIP] Startup shortcut not found.
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('[STOPPED] PID ' + $_.ProcessId) }"
echo [OK] Done.
