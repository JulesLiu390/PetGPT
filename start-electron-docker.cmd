@echo off
echo Starting PetGPT with Electron and Docker...

REM Start the Docker containers
echo Starting Docker containers...
docker-compose up -d

REM Wait a bit for containers to fully start
echo Waiting for containers to initialize...
timeout /t 5 /nobreak > nul

REM Check if backend container is running
docker ps | findstr petgpt_backend > nul
if errorlevel 1 (
  echo Backend container not running! Please check docker-compose logs.
  exit /b 1
)

REM Start the Electron app
echo Starting Electron app...
cd electron
set NODE_ENV=development
yarn start:electron

echo Done.
