@echo off
rem ---------------------------------------------------------------------------
rem  Reel Studio updater (double-click to update).
rem  Runs: git pull --ff-only -> npm install (if needed) -> build.
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

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js was not found. Install it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   git was not found. Install it from https://git-scm.com and try again.
  echo.
  pause
  exit /b 1
)

node "scripts\update.mjs" %*
echo.
pause
