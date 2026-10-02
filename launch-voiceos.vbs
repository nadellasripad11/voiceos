' Launches VoiceOS with no console window.
'
' A .lnk pointing straight at node.exe would leave a black console window open
' for as long as the app runs. WScript.Shell.Run with window style 0 starts the
' same command completely hidden, which is what a tray app should do.
'
' Goes through scripts/restart.js rather than starting Electron directly:
' Electron's single-instance lock means a second launch exits silently while
' the old copy keeps the global hotkeys, so double-clicking twice would
' otherwise look like the app had stopped working.

Option Explicit

Dim shell, fso, here, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

cmd = "cmd /c node """ & here & "\scripts\restart.js"""

' 0 = hidden window, False = do not wait for it to exit.
shell.Run cmd, 0, False
