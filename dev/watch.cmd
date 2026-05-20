@echo off
REM Dev watcher launcher for cmd.exe — forwards to watch.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0watch.ps1" %*
