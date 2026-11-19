@echo off
REM tool scan — double-click full screen scan
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 18+ and retry.
  pause
  exit /b 1
)
node scan.js --all --out report.json
echo.
echo Report saved to report.json + screen.png
pause
