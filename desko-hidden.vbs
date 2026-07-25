' ===========================================================================
'  Desko hidden launcher -- double-click to start the desk-dashboard server
'  with NO terminal window. Nothing appears on screen; the server just runs
'  in the background. To stop it, double-click  desko-stop.cmd
'
'  The QR code / open-URL banner and any errors are written to  desko.log
'  (same folder) since there's no console to print them to.
' ===========================================================================
Option Explicit

Dim sh, fso, dir, logf, cmd, port
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir  = fso.GetParentFolderName(WScript.ScriptFullName)
logf = dir & "\desko.log"
port = 7777

' Don't start a second copy if one is already serving the port -- a duplicate
' would just fail to bind and spam the log. netstat return code: 0 = a match
' (already listening), 1 = nothing listening.
Dim probe
probe = "cmd /c netstat -ano -p tcp | findstr /r /c:"":" & port & " .*LISTENING"" >nul 2>nul"
If sh.Run(probe, 0, True) = 0 Then
    WScript.Quit 0
End If

' pythonw = no console subsystem (zero window flash). Redirect stdout+stderr to
' desko.log so print()/logging still have a real destination and won't crash.
' Window style 0 = hidden; False = don't wait (return immediately).
cmd = "cmd /c cd /d " & Chr(34) & dir & Chr(34) & _
      " && pythonw -u run.py 1>> " & Chr(34) & logf & Chr(34) & " 2>&1"
sh.Run cmd, 0, False
