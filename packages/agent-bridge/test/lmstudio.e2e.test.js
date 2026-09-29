import { createTestTempDir } from "./test-temp-dir.js";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SessionVault } from "../src/index.js";

const enabled = process.env.PRIVACYAI_LM_STUDIO_E2E === "1";
const model = process.env.PRIVACYAI_LM_STUDIO_E2E_MODEL || "mistralai/ministral-3-3b";
const baseURL = process.env.PRIVACYAI_LM_STUDIO_E2E_BASE_URL || "http://127.0.0.1:1234/v1";
const PROMPT_HOOK = fileURLToPath(new URL("../bin/privacyai-prompt-hook.js", import.meta.url));
const AGENT_HOOK = fileURLToPath(new URL("../bin/privacyai-agent-hook.js", import.meta.url));

test("LM Studio protects the prompt and Bash lifecycle end to end", { skip: !enabled }, async t => {
  const root = await createTestTempDir("privacyai-lmstudio-e2e-");
  const runtimeDir = join(root, "runtime");
  const vaultDir = join(root, "vault");
  const configPath = join(root, "config.json");
  const outputPath = join(root, "restored.txt");
  const sessionId = "lmstudio-e2e-session";
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(
    configPath,
    `${JSON.stringify({
      provider: "lm-studio",
      model,
      baseURL,
      apiKey: "not-required",
      timeoutMs: 180000,
      numCtx: 4096
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const env = {
    ...process.env,
    PRIVACYAI_CONFIG_FILE: configPath,
    PRIVACYAI_WRAPPER_DIR: runtimeDir,
    PRIVACYAI_AGENT_VAULT_DIR: vaultDir,
    PRIVACYAI_AGENT_FLAVOR: "claude"
  };
  const original = "live.privacy.test@example.com";
  const prompt = `Write ${original} to ${outputPath} using Bash.`;

  const promptResult = await runHook(
    PROMPT_HOOK,
    {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt
    },
    env,
    240000
  );
  assert.equal(promptResult.code, 0, promptResult.stderr);
  const promptOutput = JSON.parse(promptResult.stdout);
  assert.equal(promptOutput.decision, "block");
  assert.match(promptOutput.reason, /PRIVACYAI_REINJECT/);

  const pendingFiles = await readdir(join(runtimeDir, "pending"));
  assert.equal(pendingFiles.length, 1);
  const pending = JSON.parse(await readFile(join(runtimeDir, "pending", pendingFiles[0]), "utf8"));
  assert.equal(pending.sanitizedPrompt.includes(original), false);

  const sessionMap = (await new SessionVault({ baseDir: vaultDir }).load(sessionId)).sessionMap;
  const placeholder = Object.entries(sessionMap).find(([, value]) => value === original)?.[0];
  assert.ok(placeholder);
  assert.equal(pending.sanitizedPrompt.includes(placeholder), true);

  const preResult = await runHook(
    AGENT_HOOK,
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_input: { command: `printf '%s' '${placeholder}' > '${outputPath}'` }
    },
    env
  );
  assert.equal(preResult.code, 0, preResult.stderr);
  const preOutput = JSON.parse(preResult.stdout);
  const restoredCommand = preOutput.hookSpecificOutput.updatedInput.command;
  assert.equal(restoredCommand.includes(original), true);
  assert.equal(restoredCommand.includes(placeholder), false);

  await execFilePromise("bash", ["-lc", restoredCommand]);
  assert.equal(await readFile(outputPath, "utf8"), original);

  const postResult = await runHook(
    AGENT_HOOK,
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_response: original
    },
    env
  );
  assert.equal(postResult.code, 0, postResult.stderr);
  const postOutput = JSON.parse(postResult.stdout);
  assert.equal(postOutput.hookSpecificOutput.updatedToolOutput, placeholder);
});

function runHook(script, event, env, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Hook process timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on("error", error => finish(error));
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("exit", code => finish(null, { code: code ?? 1, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, error => error ? reject(error) : resolve());
  });
}
