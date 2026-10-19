@echo off
rem Opens the window. Files dropped onto this .bat are transcribed headlessly instead.
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
if "%~1"=="" (
  start "" ".venv\Scripts\pythonw.exe" -m mojiokoshi
) else (
  ".venv\Scripts\python.exe" -m mojiokoshi %*
  pause
)
