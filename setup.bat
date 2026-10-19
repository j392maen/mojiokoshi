@echo off
rem First-time setup: creates .venv and installs dependencies (~3 GB incl. CUDA libraries).
setlocal
cd /d "%~dp0"
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  %PY% -m venv .venv || goto :error
)
".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :error
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :error
echo.
echo Setup complete. Double-click mojiokoshi.bat to start.
pause
exit /b 0

:error
echo.
echo Setup failed.
pause
exit /b 1
