@echo off
chcp 65001 >nul 2>&1
title Reel Studio Installer Build
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1" -ToolsOnly -PrivateNode
if errorlevel 1 goto failed
for /d %%D in ("%~dp0.runtime\node\node-v*-win-x64") do if exist "%%~D\node.exe" set "PATH=%%~D;%PATH%"
if not exist "%~dp0node_modules\.bin\electron-builder.cmd" (
  call npm.cmd ci --include=dev --no-audit --no-fund
  if errorlevel 1 goto failed
)
call npm.cmd run desktop:installer
if errorlevel 1 goto failed
call npm.cmd run desktop:verify
if errorlevel 1 goto failed
echo Installer is ready in desktop-out.
pause
exit /b 0
:failed
echo Build failed. See the error above.
pause
exit /b 1
