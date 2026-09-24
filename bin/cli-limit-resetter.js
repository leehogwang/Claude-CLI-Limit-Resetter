#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  INTERVAL_MS, AUTH_RECHECK_MS, PROVIDERS, MODEL, API_ENV,
  KeeperError, AuthError, pathsFor, ensureDirs, providerCommand,
  childEnvironment, checkAuth, pingArgs, parsePing, cliFailure,
  readState, writeState, dueIn, acquireLock, runProcess, terminateProcess,
} = require("../lib/core");

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function runLocal(command, args, timeout = 15_000) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function systemdAvailable() {
  return process.platform === "linux" &&
    runLocal("systemctl", ["--user", "show-environment"]).status === 0;
}

function unitName(provider) {
  return `cli-limit-resetter-${provider}.service`;
}

function unitPath(provider) {
  return path.join(os.homedir(), ".config", "systemd", "user", unitName(provider));
}

function unitQuote(value) {
  if (/[\r\n]/.test(value)) throw new KeeperError("Newline in service argument.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function systemdUnit(provider, cliPath) {
  const binPath = fs.realpathSync(__filename);
  const nodePath = fs.realpathSync(process.execPath);
  const args = [nodePath, binPath, "run", provider, "--cli", cliPath];
  const environment = [
    `Environment=${unitQuote(`PATH=${process.env.PATH || ""}`)}`,
    ...API_ENV[provider].map((name) => `Environment=${unitQuote(`${name}=`)}`),
  ];
  return [
    "[Unit]",
    `Description=CLI Limit Resetter (${provider})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${args.map(unitQuote).join(" ")}`,
    ...environment,
    "Restart=on-failure",
    "RestartSec=5min",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function assertLocalSuccess(result, action) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(-300);
    throw new KeeperError(`${action} failed${detail ? `: ${detail}` : "."}`);
  }
}

function importLegacyState(provider, source, destination) {
  if (provider !== "claude") {
    throw new KeeperError("--legacy-state only supports Claude.");
  }
  if (fs.existsSync(destination)) {
    throw new KeeperError("New state already exists; refusing to overwrite it.");
  }
  let old;
  try {
    old = JSON.parse(fs.readFileSync(path.resolve(source), "utf8"));
  } catch {
    throw new KeeperError("Could not read the legacy state JSON.");
  }
  if (!old || !Number.isFinite(Date.parse(old.last_attempt_at))) {
    throw new KeeperError("Legacy state has no valid last_attempt_at.");
  }
  const state = {
    lastAttemptAt: old.last_attempt_at,
    lastSuccessAt: old.last_success_at || null,
    lastModel: old.last_models_used?.join(", ") || null,
  };
  writeState(destination, state);
}

function ensureLinger() {
  const username = os.userInfo().username;
  const result = runLocal("loginctl", ["show-user", username, "-p", "Linger", "--value"]);
  if (result.status !== 0 || result.stdout.trim() === "yes") return;
  const enabled = runLocal("loginctl", ["enable-linger", username]);
  if (enabled.status !== 0) {
    log("Warning: loginctl could not enable linger; the user service may stop after logout.");
  }
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return null;
  if (index + 1 >= args.length) throw new KeeperError(`${option} needs a value.`);
  return args[index + 1];
}

async function start(provider, args) {
  const paths = pathsFor(provider);
  ensureDirs(paths);
  const cliPath = providerCommand(provider);
  await checkAuth(provider, cliPath, paths.work);
  if (provider === "claude" && systemdAvailable() &&
      runLocal("systemctl", ["--user", "is-active", "--quiet", "claude-monitor.service"]).status === 0) {
    throw new KeeperError(
      "Legacy claude-monitor.service is running. Stop it before starting the npm service."
    );
  }
  const legacy = optionValue(args, "--legacy-state");
  if (legacy) importLegacyState(provider, legacy, paths.state);
  if (systemdAvailable()) {
    fs.mkdirSync(path.dirname(unitPath(provider)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(unitPath(provider), systemdUnit(provider, cliPath), { mode: 0o600 });
    assertLocalSuccess(
      runLocal("systemctl", ["--user", "daemon-reload"]),
      "Reloading systemd"
    );
    const name = unitName(provider);
    const active = runLocal("systemctl", ["--user", "is-active", "--quiet", name]).status === 0;
    assertLocalSuccess(
      runLocal("systemctl", ["--user", "enable", "--now", name]),
      "Starting background service"
    );
    if (active) {
      assertLocalSuccess(
        runLocal("systemctl", ["--user", "restart", name]),
        "Restarting background service"
      );
    }
    ensureLinger();
    log(`${provider} background service is enabled and running (${name}).`);
    return;
  }
  if (fs.existsSync(paths.lock)) {
    let pid = 0;
    try { pid = Number(fs.readFileSync(paths.lock, "utf8")); } catch {}
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new KeeperError(`${provider} worker is already running (PID ${pid}).`);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  const out = fs.openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [
    fs.realpathSync(__filename), "run", provider, "--cli", cliPath,
  ], {
    detached: true,
    stdio: ["ignore", out, out],
    env: childEnvironment(provider),
  });
  fs.closeSync(out);
  child.unref();
  log(`${provider} started in the background (PID ${child.pid}).`);
  log("This host has no systemd user manager; detached mode does not restart after reboot.");
}

function sleepInterruptible(milliseconds, control) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      control.wake = null;
      resolve();
    }, milliseconds);
    control.wake = () => {
      clearTimeout(timer);
      control.wake = null;
      resolve();
    };
  });
}

async function runWorker(provider, args) {
  const paths = pathsFor(provider);
  ensureDirs(paths);
  const cliPath = optionValue(args, "--cli") || providerCommand(provider);
  const release = acquireLock(paths.lock);
  const control = { stopping: false, wake: null, child: null };
  const stop = () => {
    control.stopping = true;
    if (control.child) terminateProcess(control.child);
    if (control.wake) control.wake();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  log(`${provider} scheduler started; model=${MODEL[provider]}, interval=5 hours.`);
  try {
    while (!control.stopping) {
      const state = readState(paths.state);
      const waitMs = dueIn(state);
      if (waitMs > 0) {
        const next = new Date(Date.now() + waitMs).toISOString();
        log(`Next ${provider} ping: ${next}.`);
        await sleepInterruptible(waitMs, control);
        continue;
      }
      const previousAttemptAt = state.lastAttemptAt;
      let attemptedRecorded = false;
      try {
        const auth = await checkAuth(provider, cliPath, paths.work);
        if (control.stopping) break;
        state.lastAttemptAt = new Date().toISOString();
        state.lastRequestedModel = MODEL[provider];
        writeState(paths.state, state);
        attemptedRecorded = true;
        const result = await runProcess(cliPath, pingArgs(provider), {
          cwd: paths.work,
          env: childEnvironment(provider),
          onChild: (child) => { control.child = child; },
        });
        control.child = null;
        if (result.code !== 0) {
          throw cliFailure(provider, result);
        }
        const usedModel = parsePing(provider, result.stdout);
        state.lastSuccessAt = new Date().toISOString();
        state.lastAuth = auth;
        state.lastModel = usedModel;
        writeState(paths.state, state);
        log(`${provider} ping succeeded using ${auth}; model=${usedModel}.`);
      } catch (error) {
        control.child = null;
        if (control.stopping) break;
        log(`${provider} ping skipped or failed: ${error.message}`);
        if (error instanceof AuthError && provider === "agy") {
          if (attemptedRecorded) {
            if (previousAttemptAt) state.lastAttemptAt = previousAttemptAt;
            else delete state.lastAttemptAt;
            delete state.lastRequestedModel;
            writeState(paths.state, state);
          }
          log("Gemini scheduler stopped. Reauthenticate interactively, then start it again.");
          control.stopping = true;
        } else if (error instanceof AuthError) {
          await sleepInterruptible(AUTH_RECHECK_MS, control);
        } else if (!attemptedRecorded) {
          throw error;
        }
      }
    }
  } finally {
    release();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    log(`${provider} scheduler stopped.`);
  }
}

function showStatus(provider) {
  const paths = pathsFor(provider);
  const state = readState(paths.state);
  let active = false;
  let enabled = false;
  if (systemdAvailable()) {
    const unit = unitName(provider);
    active = runLocal("systemctl", ["--user", "is-active", "--quiet", unit]).status === 0;
    enabled = runLocal("systemctl", ["--user", "is-enabled", "--quiet", unit]).status === 0;
  } else if (fs.existsSync(paths.lock)) {
    try {
      process.kill(Number(fs.readFileSync(paths.lock, "utf8")), 0);
      active = true;
    } catch {}
  }
  const next = state.lastAttemptAt
    ? new Date(Date.now() + dueIn(state, INTERVAL_MS)).toISOString()
    : "now";
  process.stdout.write(
    `${provider}: active=${active}, enabled=${enabled}, lastAttempt=${state.lastAttemptAt || "never"}, ` +
    `lastSuccess=${state.lastSuccessAt || "never"}, nextDue=${next}\n`
  );
}

function stop(provider) {
  const paths = pathsFor(provider);
  if (systemdAvailable()) {
    const name = unitName(provider);
    assertLocalSuccess(
      runLocal("systemctl", ["--user", "disable", "--now", name]),
      "Stopping background service"
    );
    log(`${provider} background service stopped and disabled.`);
    return;
  }
  if (!fs.existsSync(paths.lock)) {
    log(`${provider} worker is not running.`);
    return;
  }
  const pid = Number(fs.readFileSync(paths.lock, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new KeeperError("Worker lock contains an invalid PID.");
  }
  try {
    process.kill(pid, "SIGTERM");
    log(`${provider} worker stop signal sent to PID ${pid}.`);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    log(`${provider} worker is not running.`);
  }
}

function help() {
  process.stdout.write(
    "Usage: cli-limit-resetter [start|stop|status|check] [claude|codex|agy]\n" +
    "No arguments starts Claude in the background.\n" +
    "For migration: start claude --legacy-state /path/to/state.json\n" +
    "agy uses the Gemini CLI executable (agy or gemini).\n"
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args[0] === "help") return help();
  if (args.includes("--version")) {
    process.stdout.write(require("../package.json").version + "\n");
    return;
  }
  const action = args[0] || "start";
  const provider = args[1] && !args[1].startsWith("--") ? args[1] : "claude";
  if (!PROVIDERS.includes(provider)) {
    throw new KeeperError(`Unknown provider "${provider}". Choose: ${PROVIDERS.join(", ")}.`);
  }
  if (action === "start") return start(provider, args);
  if (action === "stop") return stop(provider);
  if (action === "status") return showStatus(provider);
  if (action === "check") {
    const paths = pathsFor(provider);
    ensureDirs(paths);
    const cliPath = providerCommand(provider);
    const auth = await checkAuth(provider, cliPath, paths.work);
    if (provider === "agy") {
      log("agy is configured for Google OAuth; no model request sent. Cached credentials are not validated.");
    } else {
      log(`${provider} authenticated with ${auth}; no model request sent.`);
    }
    return;
  }
  if (action === "run") return runWorker(provider, args);
  throw new KeeperError(`Unknown action "${action}".`);
}

main().catch((error) => {
  process.stderr.write(`cli-limit-resetter: ${error.message}\n`);
  process.exitCode = 1;
});
