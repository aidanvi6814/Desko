@echo off
setlocal
title Desko - stop

REM ===========================================================================
REM  Stop the hidden Desko server. Since desko-hidden.vbs runs without a window
REM  (no Ctrl+C to press), this finds whatever is LISTENING on the port and
REM  kills it. Double-click this file, or run it from a terminal.
REM ===========================================================================

set "PORT=7777"
set "FOUND="

for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    taskkill /PID %%p /F >nul 2>nul && set "FOUND=1"
)

echo.
if defined FOUND (
    echo   Desko stopped.
) else (
    echo   Desko was not running on port %PORT%.
)
echo.
timeout /t 2 >nul
endlocal
