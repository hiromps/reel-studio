@echo off
rem Reel Studio CLI（cmd.exe / PowerShell 用）
node "%~dp0..\node_modules\tsx\dist\cli.mjs" "%~dp0..\cli\reel.ts" %*
