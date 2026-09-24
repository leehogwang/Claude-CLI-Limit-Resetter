#!/usr/bin/env python3
"""Send one small Claude Code prompt on a fixed interval using plan auth only."""

import argparse
import fcntl
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
STATE_FILE = APP_DIR / "state.json"
LOG_FILE = APP_DIR / "claude_monitor.log"
LOCK_FILE = APP_DIR / ".resetter.lock"

DEFAULT_INTERVAL_SECONDS = 5 * 60 * 60
AUTH_RECHECK_SECONDS = 5 * 60
REQUEST_TIMEOUT_SECONDS = 180
DEFAULT_MODEL = "haiku"
DEFAULT_PROMPT = "hi"

SUBSCRIPTION_TYPES = {"pro", "max", "team"}
AUTH_OVERRIDE_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
)

logger = logging.getLogger("claude_limit_resetter")


class ResetterError(Exception):
    """A safe-to-report configuration or execution error."""


class AnotherInstanceRunning(ResetterError):
    """Raised when another copy already owns the state file."""


def configure_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(LOG_FILE, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )


def configured_interval():
    raw_value = os.environ.get("PING_INTERVAL_SECONDS", str(DEFAULT_INTERVAL_SECONDS))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ResetterError("PING_INTERVAL_SECONDS must be an integer.") from exc
    if value < 1:
        raise ResetterError("PING_INTERVAL_SECONDS must be at least 1.")
    return value


def configured_model():
    value = os.environ.get("CLAUDE_MODEL", DEFAULT_MODEL).strip()
    if not value:
        raise ResetterError("CLAUDE_MODEL cannot be empty.")
    return value


def configured_prompt():
    value = os.environ.get("PING_PROMPT", DEFAULT_PROMPT)
    if not value.strip():
        raise ResetterError("PING_PROMPT cannot be empty.")
    return value


def resolve_claude():
    configured_path = os.environ.get("CLAUDE_CLI_PATH", "").strip()
    path = Path(configured_path).expanduser() if configured_path else None
    if path is None:
        found = shutil.which("claude")
        path = Path(found) if found else None
    if path is None or not path.is_file() or not os.access(path, os.X_OK):
        raise ResetterError(
            "Claude Code CLI was not found. Install it or set CLAUDE_CLI_PATH."
        )
    return str(path.resolve())


def ensure_no_auth_override():
    configured = [
        name for name in AUTH_OVERRIDE_ENV if os.environ.get(name, "").strip()
    ]
    if configured:
        raise ResetterError(
            "Refusing to send because provider/API override variables are set: "
            + ", ".join(configured)
            + ". Unset them to use the signed-in Claude subscription."
        )


def validate_auth_status(status):
    if not isinstance(status, dict) or status.get("loggedIn") is not True:
        raise ResetterError("Claude Code is not logged in.")

    auth_method = status.get("authMethod")
    api_provider = status.get("apiProvider")
    subscription = str(status.get("subscriptionType", "")).strip().lower()

    if auth_method != "claude.ai" or api_provider != "firstParty":
        raise ResetterError(
            "Refusing to send: Claude auth status is not a first-party Claude.ai "
            "subscription login."
        )
    if subscription not in SUBSCRIPTION_TYPES:
        raise ResetterError(
            "Refusing to send: no supported Claude subscription was reported."
        )
    return subscription


def check_subscription_auth(claude_path):
    ensure_no_auth_override()
    try:
        result = subprocess.run(
            [claude_path, "auth", "status", "--json"],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ResetterError(
            "Could not read Claude Code authentication status: "
            + type(exc).__name__
        ) from exc

    if result.returncode != 0:
        raise ResetterError(
            "Claude Code authentication status check failed "
            f"(exit {result.returncode})."
        )
    try:
        status = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ResetterError(
            "Claude Code returned an unreadable authentication status."
        ) from exc
    return validate_auth_status(status)


def build_ping_command(claude_path, model, prompt):
    return [
        claude_path,
        "--print",
        "--model",
        model,
        "--effort",
        "low",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--restricted",
        "--strict-mcp-config",
        "--tools",
        "",
        "--permission-prompts",
        "none",
        "--system-prompt",
        "Reply with one short word.",
        prompt,
    ]


def parse_cli_result(output, requested_model):
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise ResetterError("Claude Code returned invalid JSON output.") from exc
    if not isinstance(payload, dict) or payload.get("type") != "result":
        raise ResetterError("Claude Code did not return a completed result.")
    if payload.get("is_error") or payload.get("subtype") not in (None, "success"):
        raise ResetterError("Claude Code reported that the prompt did not complete.")

    model_usage = payload.get("modelUsage", {})
    models_used = list(model_usage) if isinstance(model_usage, dict) else []
    if requested_model.lower() == "haiku":
        if not models_used:
            raise ResetterError(
                "Claude Code did not report which model was used; refusing to "
                "mark the Haiku ping successful."
            )
        if any("haiku" not in model.lower() for model in models_used):
            raise ResetterError(
                "Claude Code did not use a Haiku model; refusing to mark the ping "
                "successful."
            )
    return models_used


def read_state():
    if not STATE_FILE.exists():
        return {}
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ResetterError(f"Could not read state file: {type(exc).__name__}") from exc
    if not isinstance(state, dict):
        raise ResetterError("State file must contain a JSON object.")
    return state


def write_state(state):
    temporary = STATE_FILE.with_suffix(".json.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, STATE_FILE)
    except OSError as exc:
        raise ResetterError(f"Could not write state file: {type(exc).__name__}") from exc


def seconds_until_due(state, now, interval_seconds):
    last_attempt = state.get("last_attempt_at")
    if not last_attempt:
        return 0
    try:
        last_time = datetime.fromisoformat(last_attempt)
    except (TypeError, ValueError) as exc:
        raise ResetterError("State file contains an invalid last_attempt_at value.") from exc
    if last_time.tzinfo is None:
        last_time = last_time.replace(tzinfo=timezone.utc)
    due_at = last_time + timedelta(seconds=interval_seconds)
    return max(0.0, (due_at - now).total_seconds())


@contextmanager
def single_instance():
    try:
        descriptor = os.open(LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError as exc:
        raise ResetterError(f"Could not open lock file: {type(exc).__name__}") from exc
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise AnotherInstanceRunning(
                "Another resetter process is already running."
            ) from exc
        yield
    finally:
        os.close(descriptor)


def safe_cli_error(stderr, stdout):
    message = (stderr or stdout or "").strip().replace("\n", " ")
    message = re.sub(r"sk-ant-[A-Za-z0-9_-]{8,}", "[redacted]", message)
    message = re.sub(
        r"(?i)(bearer\s+)[A-Za-z0-9._-]+", r"\1[redacted]", message
    )
    return message[-400:] or "no diagnostic text"


def send_ping(claude_path, model, prompt, state):
    subscription = check_subscription_auth(claude_path)
    attempted_at = datetime.now(timezone.utc)
    state["last_attempt_at"] = attempted_at.isoformat()
    state["last_requested_model"] = model
    write_state(state)

    environment = os.environ.copy()
    environment["CLAUDE_CODE_SKIP_PROMPT_HISTORY"] = "1"
    try:
        result = subprocess.run(
            build_ping_command(claude_path, model, prompt),
            check=False,
            capture_output=True,
            text=True,
            timeout=REQUEST_TIMEOUT_SECONDS,
            cwd=str(APP_DIR),
            env=environment,
        )
    except subprocess.TimeoutExpired:
        logger.error(
            "Claude prompt timed out; the attempt was recorded to prevent a "
            "duplicate request before the next interval."
        )
        return False
    except OSError as exc:
        logger.error("Could not launch Claude Code: %s", type(exc).__name__)
        return False

    if result.returncode != 0:
        logger.error(
            "Claude prompt failed (exit %s): %s",
            result.returncode,
            safe_cli_error(result.stderr, result.stdout),
        )
        return False

    try:
        models_used = parse_cli_result(result.stdout, model)
    except ResetterError as exc:
        logger.error("%s", exc)
        return False

    completed_at = datetime.now(timezone.utc)
    state["last_success_at"] = completed_at.isoformat()
    state["last_subscription_type"] = subscription
    state["last_models_used"] = models_used
    write_state(state)
    model_description = ", ".join(models_used) if models_used else model
    logger.info(
        "Ping completed using Claude.ai %s subscription; model: %s. "
        "Next attempt is scheduled in %.1f hours.",
        subscription,
        model_description,
        configured_interval() / 3600,
    )
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Send a minimal Claude Code prompt on a fixed schedule."
    )
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        "--once",
        action="store_true",
        help="Send one prompt now and record the attempt.",
    )
    modes.add_argument(
        "--check-auth",
        action="store_true",
        help="Verify first-party Claude subscription auth without sending a prompt.",
    )
    args = parser.parse_args(argv)

    configure_logging()
    try:
        claude_path = resolve_claude()
        if args.check_auth:
            subscription = check_subscription_auth(claude_path)
            logger.info(
                "Claude.ai %s subscription auth verified (first-party); no prompt sent.",
                subscription,
            )
            return 0

        model = configured_model()
        prompt = configured_prompt()
        interval_seconds = configured_interval()
        with single_instance():
            if args.once:
                return 0 if send_ping(claude_path, model, prompt, read_state()) else 1
            return run_daemon_locked(
                claude_path, model, prompt, interval_seconds
            )
    except AnotherInstanceRunning as exc:
        logger.error("%s", exc)
        return 2
    except ResetterError as exc:
        logger.error("%s", exc)
        return 2


def run_daemon_locked(claude_path, model, prompt, interval_seconds):
    logger.info(
        "Background scheduler started: model=%s interval=%s seconds.",
        model,
        interval_seconds,
    )
    while True:
        state = read_state()
        now = datetime.now(timezone.utc)
        wait_seconds = seconds_until_due(state, now, interval_seconds)
        if wait_seconds:
            due_time = now + timedelta(seconds=wait_seconds)
            logger.info("Next ping is due at %s UTC.", due_time.isoformat())
            time.sleep(wait_seconds)
            continue
        try:
            check_subscription_auth(claude_path)
        except ResetterError as exc:
            logger.error(
                "No prompt sent: %s Rechecking in %s seconds.",
                exc,
                AUTH_RECHECK_SECONDS,
            )
            time.sleep(AUTH_RECHECK_SECONDS)
            continue
        send_ping(claude_path, model, prompt, state)


if __name__ == "__main__":
    raise SystemExit(main())
