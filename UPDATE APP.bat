@echo off
title Update – Motowarehouse Booking Portal
echo.
echo  Pushing to Railway...
echo.
git add -A
git commit -m "Update booking portal"
git push
echo.
echo  Done! Changes will be live in ~1 minute.
pause
