@echo off
rem ---------------------------------------------------------------------------
rem  Reel Studio updater (double-click to update).
rem  Detects the newest release, verifies it, and updates the desktop app.
rem  Pass --source explicitly to update source code from GitHub instead.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe parses batch files with the OEM
rem  code page (CP932 on Japanese Windows), so UTF-8 Japanese text here would
rem  corrupt the script. All Japanese messages come from scripts/update.mjs.
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>&1
title Reel Studio - Update

set "REEL_DIR=%~dp0"
cd /d "%REEL_DIR%"
if errorlevel 1 (
  echo   Could not enter "%REEL_DIR%".
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REEL_DIR%scripts\run-desktop-update.ps1" %*
if errorlevel 1 goto failed
echo.
pause
exit /b 0
:failed
echo.
echo Desktop update failed. See the error above.
pause
exit /b 1
