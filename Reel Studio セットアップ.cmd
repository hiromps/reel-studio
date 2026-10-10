@echo off
chcp 65001 >nul 2>&1
title Reel Studio Setup
cd /d "%~dp0"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1" %*
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Setup completed. Open Reel Studio.cmd to start editing.
pause
