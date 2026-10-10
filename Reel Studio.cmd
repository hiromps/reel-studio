@echo off
rem ---------------------------------------------------------------------------
rem  Reel Studio launcher (desktop shortcut points here).
rem  Add --dev for the Vite dev server with HMR, --rebuild to force a rebuild.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe parses batch files with the OEM
rem  code page (CP932 on Japanese Windows), so UTF-8 Japanese text here would
rem  corrupt the script. All Japanese messages come from scripts/launch.mjs,
rem  which Node prints to the console as Unicode.
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>&1
title Reel Studio

rem Resolve this script's folder once. %~dp0 would be re-evaluated against the
rem new working directory after "cd", which breaks relative invocations.
set "REEL_DIR=%~dp0"
cd /d "%REEL_DIR%"
if errorlevel 1 (
  echo   Could not enter "%REEL_DIR%".
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REEL_DIR%scripts\bootstrap-windows.ps1" -Launch %*
if errorlevel 1 pause
