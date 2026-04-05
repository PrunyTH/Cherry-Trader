@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Cherry-Trader.ps1"

endlocal
