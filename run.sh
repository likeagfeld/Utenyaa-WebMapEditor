#!/usr/bin/env bash
# Linux/macOS launcher.
# Creates a venv on first run, installs Flask, starts the editor.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [ ! -d ".venv" ]; then
  echo "Creating .venv..."
  python3 -m venv .venv
fi

# shellcheck source=/dev/null
source ".venv/bin/activate"

python3 -m pip install --quiet --upgrade pip
python3 -m pip install --quiet -r requirements.txt

echo
echo "Starting Utenyaa Map Editor..."
echo "  open http://${UTENYAA_EDITOR_HOST:-127.0.0.1}:${UTENYAA_EDITOR_PORT:-5000}/"
echo "  Ctrl-C to stop."
echo
exec python3 webapp/app.py
