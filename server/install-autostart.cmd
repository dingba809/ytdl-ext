@echo off
setlocal
set "DIR=%~dp0"
set "VBS=%DIR%start-silent.vbs"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ytdl-ext.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath='wscript.exe'; $s.Arguments=('\"' + $env:VBS + '\"'); $s.WorkingDirectory=$env:DIR.TrimEnd('\'); $s.Description='YouTube Downloader local service'; $s.Save()"
if errorlevel 1 (
  echo [FAILED] Could not create Startup shortcut.
  exit /b 1
)

wscript.exe "%VBS%"
echo [OK] Autostart installed and service started silently.
echo Shortcut: %LINK%
echo Log file: %DIR%server.log
