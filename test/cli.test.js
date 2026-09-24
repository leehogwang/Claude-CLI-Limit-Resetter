"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { API_ENV } = require("../lib/core");

test("start explains Claude login before installing a service", (t) => {
  if (process.platform === "win32") t.skip("Shell executable fixture is Unix-only.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-keeper-login-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fakeClaude = path.join(directory, "claude");
  fs.writeFileSync(
    fakeClaude,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({loggedIn:false}));\n",
    { mode: 0o700 }
  );
  const env = {
    ...process.env,
    KEEPER_CLAUDE_CLI: fakeClaude,
    XDG_STATE_HOME: directory,
  };
  for (const name of API_ENV.claude) delete env[name];
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "cli-limit-resetter.js"), "start", "claude",
  ], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claude auth login/);
  assert.equal(
    fs.existsSync(path.join(directory, "cli-limit-resetter", "claude.json")),
    false
  );
});
