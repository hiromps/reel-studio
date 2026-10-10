@echo off
chcp 65001 >nul 2>&1
title Reel Studio Export Test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1" -ExportTest
pause
