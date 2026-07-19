import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/privacyai.js", import.meta.url));

test("published CLI exposes the native wrapper commands", async () => {
  const result = await run("node", [CLI, "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /privacyai claude/);
  assert.match(result.stdout, /privacyai codex/);
  assert.match(result.stdout, /privacyai agy/);
  assert.match(result.stdout, /privacyai onboard/);

  const version = await run("node", [CLI, "--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), "privacyai 0.0.2");
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => resolve({ code, stdout, stderr }));
  });
}
