#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
SERVICE_TEMPLATE="$SCRIPT_DIR/claude-monitor.service"
PYTHON_BIN="$(command -v python3 || true)"
CLAUDE_BIN="$(printenv CLAUDE_CLI_PATH 2>/dev/null || command -v claude || true)"
START_SERVICE=1

if [[ "$#" -gt 0 ]]; then
    if [[ "$#" -eq 1 && "$1" == "--no-start" ]]; then
        START_SERVICE=0
    else
        echo "Usage: $0 [--no-start]" >&2
        exit 2
    fi
fi

if [[ -z "$PYTHON_BIN" ]]; then
    echo "Python 3 was not found in PATH." >&2
    exit 1
fi
if [[ -z "$CLAUDE_BIN" || ! -x "$CLAUDE_BIN" ]]; then
    echo "Claude Code CLI was not found or is not executable." >&2
    echo "Set CLAUDE_CLI_PATH or add claude to PATH, then retry." >&2
    exit 1
fi
if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
    echo "Service template not found: $SERVICE_TEMPLATE" >&2
    exit 1
fi

"$PYTHON_BIN" "$SCRIPT_DIR/main.py" --check-auth

CLAUDE_BIN_DIR="$(dirname -- "$CLAUDE_BIN")"
NODE_BIN="$(command -v node || true)"
SERVICE_PATH="$CLAUDE_BIN_DIR:/usr/local/bin:/usr/bin:/bin"
if [[ -n "$NODE_BIN" ]]; then
    NODE_BIN_DIR="$(dirname -- "$NODE_BIN")"
    SERVICE_PATH="$NODE_BIN_DIR:$SERVICE_PATH"
fi

escape_template_value() {
    local value="$1"
    value="$(printf '%s' "$value" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
    printf '%s' "$value" | sed 's/[&|\\]/\\&/g'
}

REPO_DIR_VALUE="$(escape_template_value "$SCRIPT_DIR")"
PYTHON_BIN_VALUE="$(escape_template_value "$PYTHON_BIN")"
CLAUDE_BIN_VALUE="$(escape_template_value "$CLAUDE_BIN")"
PATH_VALUE="$(escape_template_value "$SERVICE_PATH")"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/claude-monitor.service"
mkdir -p "$UNIT_DIR"
TEMP_UNIT="$(mktemp "$UNIT_DIR/claude-monitor.service.XXXXXX")"
trap 'rm -f -- "$TEMP_UNIT"' EXIT

sed \
    -e "s|__REPO_DIR__|$REPO_DIR_VALUE|g" \
    -e "s|__PYTHON_BIN__|$PYTHON_BIN_VALUE|g" \
    -e "s|__CLAUDE_BIN__|$CLAUDE_BIN_VALUE|g" \
    -e "s|__PATH__|$PATH_VALUE|g" \
    "$SERVICE_TEMPLATE" > "$TEMP_UNIT"

chmod 0644 "$TEMP_UNIT"
mv -- "$TEMP_UNIT" "$UNIT_PATH"
systemctl --user daemon-reload

if [[ "$START_SERVICE" -eq 1 ]]; then
    systemctl --user enable --now claude-monitor.service
    echo "Installed and started claude-monitor.service."
else
    echo "Installed claude-monitor.service without starting it."
    echo "Start it with: systemctl --user enable --now claude-monitor.service"
fi

echo "Check status: systemctl --user status claude-monitor.service"
echo "View logs:    journalctl --user -u claude-monitor.service -f"
