' Launch local ytdl server silently without a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c cd /d """ & dir & """ && node server.mjs >> server.log 2>&1"
sh.Run cmd, 0, False
