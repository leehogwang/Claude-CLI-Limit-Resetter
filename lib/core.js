"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const INTERVAL_MS = 5 * 60 * 60 * 1000;
const AUTH_RECHECK_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const PROVIDERS = Object.freeze(["claude", "codex", "agy"]);
const MODEL = Object.freeze({
  claude: "haiku",
  codex: "gpt-6-luna",
  agy: "flash-lite",
});
const COMMANDS = Object.freeze({
  claude: ["claude"],
  codex: ["codex"],
  agy: ["agy", "gemini"],
});
const API_ENV = Object.freeze({
  claude: [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
  ],
  codex: [
    "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL", "OPENAI_IDENTITY_TOKEN_FILE",
    "OPENAI_WIF_CONFIG_FILE", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  ],
  agy: [
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  ],
});
const terminationTimers = new WeakMap();

class KeeperError extends Error {}
class AuthError extends KeeperError {}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new KeeperError(
      `Unknown provider "${provider}". Choose: ${PROVIDERS.join(", ")}.`
    );
  }
}

function stateRoot() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg)
    ? xdg
    : path.join(os.homedir(), ".local", "state");
  return path.join(base, "cli-limit-resetter");
}

function pathsFor(provider) {
  assertProvider(provider);
  const root = stateRoot();
  return {
    root,
    work: path.join(root, "work", provider),
    state: path.join(root, `${provider}.json`),
    lock: path.join(root, `${provider}.lock`),
    log: path.join(root, `${provider}.log`),
  };
}

function ensureDirs(paths) {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.work, { recursive: true, mode: 0o700 });
}

function findExecutable(name, env = process.env) {
  if (path.isAbsolute(name)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH directory.
    }
  }
  return null;
}

function providerCommand(provider, env = process.env) {
  assertProvider(provider);
  const override = env[`KEEPER_${provider.toUpperCase()}_CLI`];
  const names = override ? [override] : COMMANDS[provider];
  for (const name of names) {
    const resolved = findExecutable(name, env);
    if (resolved) return fs.realpathSync(resolved);
  }
  const expected = provider === "agy"
    ? "Gemini (agy, gemini, or KEEPER_AGY_CLI)"
    : provider;
  throw new KeeperError(`${expected} CLI was not found. Install it and retry.`);
}

function assertNoApiEnvironment(provider, env = process.env) {
  assertProvider(provider);
  const names = [
    ...API_ENV[provider],
    ...(provider === "codex"
      ? Object.keys(env).filter((name) => name.startsWith("OPENAI_IDENTITY_"))
      : []),
  ];
  const set = [...new Set(names)].filter((name) => String(env[name] || "").trim());
  if (set.length) {
    throw new AuthError(
      `Refusing ${provider}: API/provider environment override is set (${set.join(", ")}). ` +
      "Unset it before using subscription login."
    );
  }
}

function childEnvironment(provider, env = process.env) {
  const child = { ...env };
  for (const name of API_ENV[provider]) delete child[name];
  if (provider === "codex") {
    for (const name of Object.keys(child)) {
      if (name.startsWith("OPENAI_IDENTITY_")) delete child[name];
    }
  }
  if (provider === "claude") child.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  return child;
}

function runProcess(executable, args, options = {}) {
  const { cwd, env = process.env, timeoutMs = REQUEST_TIMEOUT_MS, onChild } = options;
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (onChild) onChild(child);
    const timer = setTimeout(() => {
      terminateProcess(child);
      finish(new KeeperError(`CLI timed out after ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
    timer.unref();
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    function collect(current, chunk) {
      const next = current + chunk.toString("utf8");
      if (next.length > 2 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new KeeperError("CLI output exceeded the 2 MiB safety limit."));
      }
      return next;
    }
    child.stdout.on("data", (chunk) => { output = collect(output, chunk); });
    child.stderr.on("data", (chunk) => { errors = collect(errors, chunk); });
    child.on("error", (error) => finish(new KeeperError(
      `Could not run CLI: ${error.code || error.name}.`
    )));
    child.on("close", (code) => finish(null, { code, stdout: output, stderr: errors }));
  });
}

function terminateProcess(child, graceMs = 2_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const groupExists = () => {
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  };
  const signal = (name) => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error.code !== "ESRCH") {
        try { child.kill(name); } catch {}
      }
    }
  };
  signal("SIGTERM");
  if (terminationTimers.has(child)) return;
  const forceTimer = setTimeout(() => {
    if (groupExists()) signal("SIGKILL");
    terminationTimers.delete(child);
  }, graceMs);
  forceTimer.unref();
  terminationTimers.set(child, forceTimer);
  child.once("close", () => {
    if (!groupExists()) {
      clearTimeout(forceTimer);
      terminationTimers.delete(child);
    }
  });
}

function parseClaudeAuth(output) {
  let status;
  try { status = JSON.parse(output); } catch {
    throw new AuthError("Claude authentication status was not valid JSON.");
  }
  const allowed = ["pro", "max", "team"];
  const subscription = String(status.subscriptionType || "").toLowerCase();
  if (status.loggedIn !== true ||
      status.authMethod !== "claude.ai" ||
      status.apiProvider !== "firstParty" ||
      !allowed.includes(subscription)) {
    throw new AuthError(
      "Claude is not signed in with an included Claude.ai subscription. " +
      "Run 'claude auth login' first. Usage-based Enterprise and API key logins are not accepted."
    );
  }
  return subscription;
}

function parseCodexAuth(output) {
  if (!/Logged in using ChatGPT\b/i.test(output)) {
    throw new AuthError(
      "Codex is not signed in with ChatGPT. Run 'codex login' first; API key login is not accepted."
    );
  }
  return "ChatGPT";
}

function checkGeminiAuth(env = process.env) {
  const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    throw new AuthError(
      "Gemini Google login was not found. Run 'gemini' and choose 'Sign in with Google' first."
    );
  }
  if (settings?.security?.auth?.selectedType !== "oauth-personal" ||
      (settings?.security?.auth?.enforcedType &&
       settings.security.auth.enforcedType !== "oauth-personal")) {
    throw new AuthError(
      "Gemini is not set to Google account login. Run 'gemini' and choose 'Sign in with Google' first."
    );
  }
  const systemSettings = process.platform === "linux"
    ? "/etc/gemini-cli/settings.json"
    : process.platform === "darwin"
      ? "/Library/Application Support/GeminiCli/settings.json"
      : null;
  if (systemSettings && fs.existsSync(systemSettings)) {
    try {
      const system = JSON.parse(fs.readFileSync(systemSettings, "utf8"));
      const enforced = system?.security?.auth?.enforcedType ||
        system?.security?.auth?.selectedType;
      if (enforced && enforced !== "oauth-personal") {
        throw new AuthError("Gemini system settings enforce a different auth method.");
      }
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("Could not verify Gemini system authentication settings.");
    }
  }
  for (const file of [
    path.join(os.homedir(), ".gemini", ".env"),
    path.join(os.homedir(), ".env"),
  ]) {
    if (!fs.existsSync(file)) continue;
    const contents = fs.readFileSync(file, "utf8");
    if (/^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_APPLICATION_CREDENTIALS)\s*=/m.test(contents)) {
      throw new AuthError(
        `Gemini may load an API/provider key from ${file}; remove it before using Google login.`
      );
    }
  }
  return "Google OAuth";
}

function cliFailure(provider, result) {
  const detail = (result.stderr || result.stdout || "").trim();
  if (provider === "agy" && /manual authorization is required/i.test(detail)) {
    return new AuthError(
      "Gemini needs interactive sign-in. Run 'gemini' in a terminal, complete Sign in with Google, " +
      "then run 'cli-limit-resetter start agy' again."
    );
  }
  return new KeeperError(
    `${provider} CLI exited with code ${result.code}${detail ? `: ${detail.slice(-800)}` : "."}`
  );
}

async function checkAuth(provider, executable, workdir, env = process.env) {
  assertNoApiEnvironment(provider, env);
  if (provider === "agy") return checkGeminiAuth(env);
  const args = provider === "claude"
    ? ["auth", "status", "--json"]
    : ["login", "status"];
  const result = await runProcess(executable, args, {
    cwd: workdir,
    env: childEnvironment(provider, env),
    timeoutMs: 20_000,
  });
  if (result.code !== 0) {
    const hint = provider === "claude" ? "claude auth login" : "codex login";
    throw new AuthError(`${provider} authentication check failed. Run '${hint}' first.`);
  }
  return provider === "claude"
    ? parseClaudeAuth(result.stdout)
    : parseCodexAuth(result.stdout + result.stderr);
}

function pingArgs(provider, model = MODEL[provider]) {
  assertProvider(provider);
  if (provider === "claude") {
    return [
      "--print", "--model", model, "--effort", "low",
      "--output-format", "json", "--no-session-persistence",
      "--restricted", "--strict-mcp-config", "--tools", "",
      "--permission-prompts", "none",
      "--system-prompt", "Reply with one short word.", "hi",
    ];
  }
  if (provider === "codex") {
    return [
      "exec", "--json", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--sandbox", "read-only", "--skip-git-repo-check",
      "--model", model, "-c", 'model_reasoning_effort="low"',
      "Reply with only hi. Do not inspect files or use tools.",
    ];
  }
  return [
    "--model", model, "--prompt", "Reply with only hi.",
    "--output-format", "json", "--approval-mode", "plan", "--skip-trust",
  ];
}

function parsePing(provider, output, model = MODEL[provider]) {
  if (provider === "claude") {
    let result;
    try { result = JSON.parse(output); } catch {
      throw new KeeperError("Claude returned invalid JSON.");
    }
    if (result?.type !== "result" || result.is_error ||
        (result.subtype && result.subtype !== "success")) {
      throw new KeeperError("Claude did not complete the ping.");
    }
    const used = result.modelUsage && typeof result.modelUsage === "object"
      ? Object.keys(result.modelUsage)
      : [];
    if (model === "haiku" &&
        (!used.length || used.some((name) => !name.toLowerCase().includes("haiku")))) {
      throw new KeeperError("Claude did not confirm Haiku as the used model.");
    }
    return used.join(", ") || model;
  }
  if (provider === "codex") {
    let completed = false;
    let answer = false;
    for (const line of output.trim().split("\n")) {
      let event;
      try { event = JSON.parse(line); } catch {
        throw new KeeperError("Codex returned invalid JSONL.");
      }
      if (event.type === "turn.failed" || event.type === "error") {
        throw new KeeperError("Codex reported a failed turn.");
      }
      if (event.type === "turn.completed") completed = true;
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        answer = true;
      }
    }
    if (!completed || !answer) throw new KeeperError("Codex did not complete the ping.");
    return model;
  }
  let result;
  try { result = JSON.parse(output); } catch {
    throw new KeeperError("Gemini returned invalid JSON.");
  }
  if (result?.error || typeof result?.response !== "string" ||
      !result.response.trim()) {
    throw new KeeperError("Gemini did not complete the ping.");
  }
  const used = result.stats?.models && typeof result.stats.models === "object"
    ? Object.keys(result.stats.models)
    : [];
  if (model === "flash-lite" &&
      (!used.length || used.some((name) => !name.toLowerCase().includes("flash-lite")))) {
    throw new KeeperError("Gemini did not confirm Flash-Lite as the used model.");
  }
  return used.join(", ") || model;
}

function readState(file) {
  if (!fs.existsSync(file)) return {};
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new KeeperError("State file must contain a JSON object.");
  }
  return state;
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

function dueIn(state, intervalMs = INTERVAL_MS, now = Date.now()) {
  const attempts = [state.lastAttemptAt, state.lastSuccessAt]
    .filter(Boolean).map((stamp) => Date.parse(stamp));
  if (attempts.some((stamp) => !Number.isFinite(stamp))) {
    throw new KeeperError("State contains an invalid timestamp.");
  }
  if (!attempts.length) return 0;
  return Math.max(0, Math.max(...attempts) + intervalMs - now);
}

function acquireLock(file) {
  function create() {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  }
  try { create(); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid = 0;
    try { pid = Number(fs.readFileSync(file, "utf8")); } catch {}
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new KeeperError("Another keeper process is already running.");
      } catch (checkError) {
        if (checkError.code !== "ESRCH") throw checkError;
      }
    }
    fs.unlinkSync(file);
    create();
  }
  return () => {
    try {
      if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
    } catch {}
  };
}

module.exports = {
  INTERVAL_MS, AUTH_RECHECK_MS, REQUEST_TIMEOUT_MS,
  PROVIDERS, MODEL, API_ENV, KeeperError, AuthError,
  stateRoot, pathsFor, ensureDirs, providerCommand,
  assertNoApiEnvironment, childEnvironment, runProcess,
  terminateProcess,
  parseClaudeAuth, parseCodexAuth, checkGeminiAuth, checkAuth,
  cliFailure, pingArgs, parsePing, readState, writeState, dueIn, acquireLock,
};
