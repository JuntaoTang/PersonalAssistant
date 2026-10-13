Option Explicit
Dim files, shell, root, command, arg, result
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & files.BuildPath(root, "scripts\control.ps1") & Chr(34) & " -Action stop"
For Each arg In WScript.Arguments
    If LCase(arg) = "/quiet" Then command = command & " -Quiet"
Next
result = shell.Run(command, 0, True)
WScript.Quit result
