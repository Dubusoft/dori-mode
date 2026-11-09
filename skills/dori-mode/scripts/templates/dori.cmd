@echo off
rem dori for CreateProcess and PATHEXT callers. cmd re-parses percent signs, carets, ampersands and quotes in the
rem arguments, so text with them can change: prefer dori.ps1 or dori.
setlocal
set /p DORI_BUN_VERSION=<"%~dp0bun.txt"
"%~dp0..\bun\%DORI_BUN_VERSION%\bun.exe" "%~dp0dori.js" %*
exit /b %ERRORLEVEL%
