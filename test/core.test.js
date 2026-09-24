"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../lib/core");

test("subscription auth rejects API credentials and usage-based enterprise", () => {
  const pro = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
  };
  assert.equal(core.parseClaudeAuth(JSON.stringify(pro)), "pro");
  assert.throws(
    () => core.parseClaudeAuth(JSON.stringify({ ...pro, subscriptionType: "enterprise" })),
    core.AuthError
  );
  assert.throws(
    () => core.parseClaudeAuth(JSON.stringify({ ...pro, authMethod: "apiKey" })),
    core.AuthError
  );
  assert.throws(
    () => core.assertNoApiEnvironment("claude", { ANTHROPIC_API_KEY: "set" }),
    core.AuthError
  );
});

test("Codex requires ChatGPT login and rejects API and workload identity overrides", () => {
  assert.equal(core.parseCodexAuth("Logged in using ChatGPT"), "ChatGPT");
  assert.throws(() => core.parseCodexAuth("Logged in using an API key"), core.AuthError);
  assert.throws(
    () => core.assertNoApiEnvironment("codex", { CODEX_API_KEY: "set" }),
    core.AuthError
  );
  assert.throws(
    () => core.assertNoApiEnvironment("codex", { OPENAI_IDENTITY_TOKEN_FILE: "/tmp/token" }),
    core.AuthError
  );
  const env = core.childEnvironment("codex", {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "secret",
    OPENAI_IDENTITY_TOKEN_FILE: "/tmp/token",
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_IDENTITY_TOKEN_FILE, undefined);
  assert.equal(env.PATH, "/usr/bin");
});

test("all provider commands select the small model and limit actions", () => {
  const claude = core.pingArgs("claude");
  assert.deepEqual(claude.slice(0, 3), ["--print", "--model", "haiku"]);
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  const codex = core.pingArgs("codex");
  assert.equal(codex[codex.indexOf("--model") + 1], "gpt-6-luna");
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");
  assert.ok(codex.includes("--ignore-user-config"));
  assert.ok(codex.includes("--ephemeral"));
  const gemini = core.pingArgs("agy");
  assert.equal(gemini[gemini.indexOf("--model") + 1], "flash-lite");
  assert.equal(gemini[gemini.indexOf("--approval-mode") + 1], "plan");
  assert.ok(gemini.includes("--skip-trust"));
});

test("Gemini provider resolves either agy or gemini executable names", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-gemini-bin-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const agy = path.join(directory, "agy");
  fs.writeFileSync(agy, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(agy, 0o755);
  assert.equal(core.providerCommand("agy", { PATH: directory }), agy);
  fs.unlinkSync(agy);
  const gemini = path.join(directory, "gemini");
  fs.writeFileSync(gemini, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(gemini, 0o755);
  assert.equal(core.providerCommand("agy", { PATH: directory }), gemini);
});

test("Gemini interactive reauthentication errors direct the user to sign in", () => {
  const failure = core.cliFailure("agy", {
    code: 41,
    stderr: "Manual authorization is required but the current session is non-interactive.",
  });
  assert.ok(failure instanceof core.AuthError);
  assert.match(failure.message, /Run 'gemini' in a terminal/);
  const otherFailure = core.cliFailure("agy", { code: 1, stderr: "network unavailable" });
  assert.match(otherFailure.message, /network unavailable/);
});

test("Claude success must confirm Haiku in result usage", () => {
  assert.equal(
    core.parsePing("claude", JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      modelUsage: { "claude-haiku-4-5-20251001": {} },
    })),
    "claude-haiku-4-5-20251001"
  );
  assert.throws(
    () => core.parsePing("claude", JSON.stringify({
      type: "result", subtype: "success", is_error: false,
    })),
    core.KeeperError
  );
  assert.throws(
    () => core.parsePing("claude", JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      modelUsage: { "claude-sonnet-5": {} },
    })),
    core.KeeperError
  );
});

test("Codex JSONL must contain an agent answer and completed turn", () => {
  const ok = [
    { type: "thread.started", thread_id: "123" },
    { type: "item.completed", item: { type: "agent_message", text: "hi" } },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
  ].map(JSON.stringify).join("\n");
  assert.equal(core.parsePing("codex", ok), "gpt-6-luna");
  assert.throws(
    () => core.parsePing("codex", JSON.stringify({ type: "turn.completed" })),
    core.KeeperError
  );
  assert.throws(
    () => core.parsePing("codex", JSON.stringify({ type: "turn.failed" })),
    core.KeeperError
  );
});

test("Gemini JSON must contain a response", () => {
  assert.equal(
    core.parsePing("agy", '{"response":"hi","stats":{"models":{"gemini-2.5-flash-lite":{}}}}'),
    "gemini-2.5-flash-lite"
  );
  assert.throws(() => core.parsePing("agy", '{"error":{"message":"quota"}}'), core.KeeperError);
  assert.throws(
    () => core.parsePing("agy", '{"response":"hi","stats":{"models":{"gemini-2.5-pro":{}}}}'),
    core.KeeperError
  );
});

test("next ping is five hours after the later of attempt and success", () => {
  const now = Date.parse("2026-09-24T07:00:00Z");
  assert.equal(core.dueIn({}, core.INTERVAL_MS, now), 0);
  assert.equal(core.dueIn({
    lastAttemptAt: "2026-09-24T01:00:00Z",
    lastSuccessAt: "2026-09-24T02:30:00Z",
  }, core.INTERVAL_MS, now), 30 * 60 * 1000);
  assert.equal(core.dueIn({
    lastAttemptAt: "2026-09-24T02:30:00Z",
    lastSuccessAt: "2026-09-24T01:00:00Z",
  }, core.INTERVAL_MS, now), 30 * 60 * 1000);
});

test("state survives an atomic write and a duplicate worker is rejected", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-keeper-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "claude.json");
  core.writeState(file, { lastAttemptAt: "2026-09-24T01:00:00Z" });
  assert.equal(core.readState(file).lastAttemptAt, "2026-09-24T01:00:00Z");
  const lock = path.join(directory, "claude.lock");
  const release = core.acquireLock(lock);
  assert.throws(() => core.acquireLock(lock), core.KeeperError);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test("timed-out CLI processes terminate their child process group", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-process-tree-test-"));
  const marker = path.join(directory, "heartbeat");
  const pidFile = path.join(directory, "child.pid");
  t.after(() => {
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const childScript =
    `process.on("SIGTERM",()=>{});setInterval(()=>require("node:fs").appendFileSync(${JSON.stringify(marker)},"x"),50);`;
  const parentScript =
    `const fs=require("node:fs");const {spawn}=require("node:child_process");` +
    `const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});` +
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  await assert.rejects(
    core.runProcess(process.execPath, ["-e", parentScript], { timeoutMs: 1000 }),
    /CLI timed out/
  );
  await new Promise((resolve) => setTimeout(resolve, 2300));
  const stoppedSize = fs.statSync(marker).size;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fs.statSync(marker).size, stoppedSize);
});
