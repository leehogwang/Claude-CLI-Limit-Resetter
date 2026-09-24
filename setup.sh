#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PYTHON_BIN="$(command -v python3 || true)"

if [[ -z "$PYTHON_BIN" ]]; then
    echo "Python 3 was not found in PATH." >&2
    exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
    echo "Claude Code CLI was not found in PATH." >&2
    exit 1
fi

echo "Python: $("$PYTHON_BIN" --version)"
echo "Claude Code: $(claude --version)"
"$PYTHON_BIN" "$SCRIPT_DIR/main.py" --check-auth
echo
echo "No Python packages or API keys are required."
echo "Send one verification prompt with: python3 main.py --once"
echo "Install and start the background service with: ./install-service.sh"
