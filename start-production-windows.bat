@echo off
cd /d %~dp0
if not exist .env.production (
  echo Crie .env.production a partir de .env.production.example
  exit /b 1
)
node --env-file=.env.production server.js
