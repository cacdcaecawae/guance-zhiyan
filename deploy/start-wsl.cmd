@echo off
rem Start all Guance services in WSL (deploy/guance.sh run) in a hidden window; closing this window keeps them running.
rem Copy to the desktop and double-click. Edit REPO / DISTRO below if the repo is not ~/guance-app or the distro is not Ubuntu.
rem Keep this file ASCII-only: cmd misparses lines with multi-byte characters under code page 65001. See docs/DEPLOY.md.
set REPO=~/guance-app
set DISTRO=Ubuntu
rem The hidden wsl.exe keeps running, so WSL does not shut down when idle and take the services with it.
rem One argument string: Windows PowerShell does not quote array arguments that contain spaces.
powershell -NoProfile -Command "Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-d %DISTRO% -- bash -lc \"%REPO%/deploy/guance.sh run\"'"
echo Starting, status in 30 seconds...
powershell -NoProfile -Command "Start-Sleep 30"
rem UTF-8 output so the Chinese status text from bash displays correctly
chcp 65001 >nul
wsl.exe -d %DISTRO% -- bash -lc "%REPO%/deploy/guance.sh status"
pause
