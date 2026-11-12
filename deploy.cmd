@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
if errorlevel 1 (
  echo Deployment failed. Review the error above.
  exit /b 1
)
echo Deployment completed successfully.
