@echo off
title Update – Motowarehouse Booking Portal
cd /d "%~dp0"
echo.
echo  Cleaning up any stale git locks...
if exist ".git\index.lock" del /f ".git\index.lock"
if exist ".git\HEAD.lock"  del /f ".git\HEAD.lock"
echo.
echo  Pushing to Railway...
echo.
git add -A
git commit -m "Update booking portal"
git push
echo.
echo  Done! Changes will be live in ~1 minute.
pause
