@echo off
title Motowarehouse Service Booking Portal
echo.
echo  ==========================================
echo   MOTOWAREHOUSE SERVICE BOOKING PORTAL
echo  ==========================================
echo.

if not exist .env (
  echo  [!] .env file not found!
  echo  [!] Copy .env.example to .env and fill in your details.
  echo.
  pause
  exit
)

echo  Starting server...
echo  Booking form:  http://localhost:3001
echo  Admin panel:   http://localhost:3001/admin
echo.
echo  Press Ctrl+C to stop the server.
echo.

node server.js
pause
