@echo off
REM Windows launcher.
REM Creates a venv on first run, installs Flask, starts the editor.
setlocal

set HERE=%~dp0
cd /d "%HERE%"

if not exist .venv (
  echo Creating .venv...
  python -m venv .venv
  if errorlevel 1 (
    echo Failed to create venv. Install Python 3 from python.org and re-run.
    exit /b 1
  )
)

call .venv\Scripts\activate.bat
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

echo.
echo Starting Utenyaa Map Editor...
echo   open http://%UTENYAA_EDITOR_HOST%:%UTENYAA_EDITOR_PORT%/   (defaults: 127.0.0.1:5000)
echo   Ctrl-C to stop.
echo.
python webapp\app.py
