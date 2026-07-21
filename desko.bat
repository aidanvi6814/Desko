@echo off
setlocal
title Desko

REM ===========================================================================
REM  Desko launcher -- double-click this file (or run it from a terminal) to
REM  start the desk-dashboard server. Keep this window open while you use it:
REM  your phone connects to the URL / QR code printed below. Close the window
REM  (or press Ctrl+C) to stop the server.
REM ===========================================================================

REM Run from the folder this script lives in. run.py loads config.json and the
REM web/ assets via paths relative to the project root, so this must be right
REM even when the file is double-clicked from somewhere else.
cd /d "%~dp0"

REM Use 'python' (the interpreter that has the dependencies installed); fall
REM back to the 'py' launcher only if 'python' isn't on PATH.
set "PY=python"
where python >nul 2>nul || set "PY=py"

REM Must match "port" in config.json. Only used for the friendly "already
REM running" check below -- run.py reads the real port from config.json itself.
set "PORT=7777"

REM --- already running? -------------------------------------------------------
REM Pure-batch port probe. (The old version embedded a multi-line python -c
REM here; cmd parses newlines inside it as separate commands, which is why it
REM kept failing. netstat + findstr needs nothing extra.) If something is
REM already LISTENING on the port, don't start a second copy that would just
REM fail to bind.
netstat -ano -p tcp | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo.
    echo   Desko ^(or something else^) is already running on port %PORT%.
    echo   Open it on this PC:  http://localhost:%PORT%
    echo.
    echo   If that isn't Desko, close whatever is using port %PORT% ^(or change
    echo   the port in config.json^) and run this again.
    echo.
    pause
    exit /b 0
)

echo.
echo ============================================================
echo   Desko desk dashboard
echo   folder : %CD%
echo   python : %PY%
echo ============================================================

REM Forward any extra args, e.g.  desko.bat --demo  (run.py handles --demo and
REM --port). With no args it just serves the real dashboard on the config port.
REM -u = unbuffered, so the URL + QR code print immediately instead of being
REM held in a buffer.
"%PY%" -u run.py %*
set "RC=%errorlevel%"

echo.
echo ------------------------------------------------------------
echo   Desko has stopped ^(exit code %RC%^).
echo   Press any key to close this window.
pause >nul
endlocal
