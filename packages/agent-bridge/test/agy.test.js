import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildAgyHookConfig,
  installAgyGlobalHook,
  launchAgy,
  parseAgyArguments,
  processAgyHookEvent
} from "../src/index.js";

const AGY_HOOK = fileURLToPath(new URL("../bin/privacyai-agy-hook.js", import.meta.url));

test("AGY argument parsing extracts separate and inline one-shot prompts", () => {
  assert.deepEqual(parseAgyArguments(["--model", "auto", "--print", "hello"]), {
    prompt: "hello",
    promptIndex: 3,
    promptStyle: "separate"
  });
  assert.deepEqual(parseAgyArguments(["--prompt=hello world"]), {
    prompt: "hello world",
    promptIndex: 0,
    promptStyle: "inline:--prompt"
  });
  assert.deepEqual(parseAgyArguments(["-p=hello"]), {
    prompt: "hello",
    promptIndex: 0,
    promptStyle: "inline:-p"
  });
});

test("AGY argument parsing fails closed for interactive, resumed, and permission-bypass modes", () => {
  for (const args of [
    [],
    ["--prompt-interactive", "hello"],
    ["--prompt-interactive=hello"],
    ["--print", "hello", "--continue"],
    ["--conversation=abc", "--print", "hello"],
    ["--dangerously-skip-permissions", "--print", "hello"]
  ]) {
    assert.throws(() => parseAgyArguments(args), /one-shot|cannot launch AGY/);
  }
  assert.throws(
    () => parseAgyArguments(["--print", "one", "--prompt", "two"]),
    /exactly one prompt/
  );
});

test("AGY pre-tool hook isolates all tools when the prompt contains private data", () => {
  const map = { "[EMAIL_1]": "real.person@example.test" };

  assert.deepEqual(
    processAgyHookEvent({ toolCall: { name: "write_file", args: { text: "[EMAIL_1]" } } }, map),
    {
      decision: "deny",
      reason:
        "PrivacyAI blocked this AGY tool call because 1 private placeholder(s) cannot be restored by the current AGY hook API."
    }
  );

  assert.deepEqual(
    processAgyHookEvent(
      { toolCall: { name: "send_email", args: { to: "real.person@example.test" } } },
      map
    ),
    {
      decision: "deny",
      reason: "PrivacyAI blocked this AGY tool call because it contained a known local private value."
    }
  );

  const cleanArgs = processAgyHookEvent(
    { toolCall: { name: "run_command", args: { CommandLine: "pwd" } } },
    map
  );
  assert.equal(cleanArgs.decision, "deny");
  assert.match(cleanArgs.reason, /prompt-only isolation/);
});

test("AGY pre-tool hook isolates clean tool calls even when the prompt map is empty", () => {
  const result = processAgyHookEvent(
    { toolCall: { name: "run_command", args: { CommandLine: "pwd" } } },
    {}
  );
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /prompt-only isolation/);
  assert.match(result.reason, /newly discovered private data/);
  assert.deepEqual(processAgyHookEvent({ toolCall: null }, {}), {});
});

test("AGY global hook installation merges existing hooks and restores exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-hooks-"));
  const hooksPath = join(root, "config", "hooks.json");
  const mapPath = join(root, "map.json");
  const original = '{\n  "existing": {"enabled": false}\n}\n';
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(hooksPath, original, { mode: 0o640 });
  await writeFile(mapPath, '{"sessionMap":{}}\n', { mode: 0o600 });

  const cleanup = await installAgyGlobalHook({
    hooksPath,
    lockPath: join(root, "hook.lock"),
    hookName: "privacyai-agent-bridge-test",
    mapPath,
    sessionToken: "test-token",
    nodePath: "/test/node"
  });

  const installed = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.deepEqual(installed.existing, { enabled: false });
  const installedCommand = installed["privacyai-agent-bridge-test"].PreToolUse[0].hooks[0].command;
  assert.match(installedCommand, /'\/test\/node'.*privacyai-agy-hook\.js.*--session-map/);
  assert.doesNotMatch(installedCommand, /test-token|--session-token/);
  assert.equal((await stat(hooksPath)).mode & 0o777, 0o600);

  await cleanup();
  assert.equal(await readFile(hooksPath, "utf8"), original);
  assert.equal((await stat(hooksPath)).mode & 0o777, 0o640);
});

test("AGY hook cleanup preserves concurrent external hook changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-hook-change-"));
  const hooksPath = join(root, "hooks.json");
  const mapPath = join(root, "map.json");
  await writeFile(hooksPath, '{"existing":{}}\n');
  await writeFile(mapPath, '{"sessionMap":{}}\n');

  const cleanup = await installAgyGlobalHook({
    hooksPath,
    lockPath: join(root, "hook.lock"),
    hookName: "privacyai-agent-bridge-test",
    mapPath,
    sessionToken: "test-token"
  });
  const changed = JSON.parse(await readFile(hooksPath, "utf8"));
  changed.external = { enabled: true };
  await writeFile(hooksPath, `${JSON.stringify(changed)}\n`);

  await cleanup();
  assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), {
    existing: {},
    external: { enabled: true }
  });
});

test("AGY hook installation recovers a lock owned by a dead process", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-stale-lock-"));
  const hooksPath = join(root, "hooks.json");
  const lockPath = join(root, "hook.lock");
  const mapPath = join(root, "map.json");
  await writeFile(lockPath, "99999999\n", { mode: 0o600 });
  await writeFile(mapPath, '{"sessionMap":{}}\n');

  const cleanup = await installAgyGlobalHook({
    hooksPath,
    lockPath,
    hookName: "privacyai-agent-bridge-test",
    mapPath,
    sessionToken: "test-token",
    lockTimeoutMs: 500
  });
  assert.ok(JSON.parse(await readFile(hooksPath, "utf8"))["privacyai-agent-bridge-test"]);
  await cleanup();
});

test(
  "AGY hook installation recovers a recycled-PID lock on Linux",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "privacyai-agy-recycled-lock-"));
    const hooksPath = join(root, "hooks.json");
    const lockPath = join(root, "hook.lock");
    const mapPath = join(root, "map.json");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        token: "old-owner",
        processStart: "definitely-not-the-current-process"
      })}\n`,
      { mode: 0o600 }
    );
    await writeFile(mapPath, '{"sessionToken":"test-token","sessionMap":{}}\n');

    const cleanup = await installAgyGlobalHook({
      hooksPath,
      lockPath,
      hookName: "privacyai-agent-bridge-test",
      mapPath,
      sessionToken: "test-token",
      lockTimeoutMs: 500
    });
    assert.ok(JSON.parse(await readFile(hooksPath, "utf8"))["privacyai-agent-bridge-test"]);
    await cleanup();
  }
);

test("AGY cleanup preserves a replacement lock owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-lock-owner-"));
  const hooksPath = join(root, "hooks.json");
  const lockPath = join(root, "hook.lock");
  const mapPath = join(root, "map.json");
  await writeFile(mapPath, '{"sessionToken":"test-token","sessionMap":{}}\n');

  const cleanup = await installAgyGlobalHook({
    hooksPath,
    lockPath,
    hookName: "privacyai-agent-bridge-test",
    mapPath,
    sessionToken: "test-token"
  });
  const replacement = `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "replacement-owner" })}\n`;
  await writeFile(lockPath, replacement, { mode: 0o600 });

  await cleanup();
  assert.equal(await readFile(lockPath, "utf8"), replacement);
});

test("AGY launch sanitizes the prompt before spawning and keeps the guard installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-launch-"));
  const hooksPath = join(root, "hooks.json");
  const stderr = new PassThrough();
  let warning = "";
  stderr.on("data", chunk => { warning += chunk; });
  let observed;

  const code = await launchAgy(["--model", "auto", "--print", "Email real@example.test"], {
    cwd: root,
    binary: "/test/agy",
    sessionToken: "launch-token",
    hooksPath,
    lockPath: join(root, "hook.lock"),
    stderr,
    loadPrivacyConfig: async () => ({
      configured: true,
      path: join(root, "privacy-config.json"),
      config: { provider: "ollama", model: "test", baseURL: "http://127.0.0.1:11434" }
    }),
    checkPrivacyModel: async () => ({ ok: true }),
    sanitizer: async () => ({
      sanitizedPrompt: "Email [EMAIL_1]",
      sessionMap: { "[EMAIL_1]": "real@example.test" }
    }),
    runChild: async (binary, args, options) => {
      const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
      const hookName = Object.keys(hooks).find(name => name.startsWith("privacyai-agent-bridge-"));
      assert.ok(hookName);
      observed = { binary, args, options };
      return 23;
    }
  });

  assert.equal(code, 23);
  assert.equal(observed.binary, "/test/agy");
  assert.deepEqual(observed.args, ["--model", "auto", "--print", "Email [EMAIL_1]"]);
  assert.equal(observed.options.cwd, root);
  assert.equal(observed.options.env.PRIVACYAI_AGENT_FLAVOR, "agy");
  assert.equal(observed.options.env.PRIVACYAI_AGY_SESSION_TOKEN, "launch-token");
  assert.match(warning, /all tools are isolated/);
  await assert.rejects(readFile(hooksPath), error => error?.code === "ENOENT");
});

test("AGY hook executable ignores unrelated AGY processes before reading the session map", async () => {
  const result = await runHook(
    ["--session-map", "/definitely/missing/map.json"],
    { toolCall: { name: "run_command", args: { CommandLine: "pwd" } } },
    {}
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    decision: "allow",
    reason: "PrivacyAI AGY guard is scoped to a different process."
  });
});

test("AGY hook executable enforces the map only for its scoped process", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-hook-scope-"));
  const mapPath = join(root, "map.json");
  await writeFile(
    mapPath,
    JSON.stringify({
      sessionToken: "expected",
      sessionMap: { "[EMAIL_1]": "real.person@example.test" }
    })
  );
  const result = await runHook(
    ["--session-map", mapPath],
    { toolCall: { name: "run_command", args: { CommandLine: "pwd" } } },
    { PRIVACYAI_AGY_SESSION_TOKEN: "expected" }
  );
  assert.equal(result.code, 0);
  assert.match(JSON.parse(result.stdout).reason, /prompt-only isolation/);
});

test("AGY hook config uses wildcard pre-tool matching", () => {
  const config = buildAgyHookConfig({
    hookName: "privacyai-agent-bridge-test",
    mapPath: "/tmp/map.json",
    sessionToken: "test-token",
    nodePath: "/usr/bin/node",
    toolTimeout: 9
  });
  const spec = config["privacyai-agent-bridge-test"].PreToolUse[0];
  assert.equal(spec.matcher, "*");
  assert.equal(spec.hooks[0].timeout, 9);
  assert.doesNotMatch(spec.hooks[0].command, /test-token|--session-token/);
});

function runHook(args, event, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGY_HOOK, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}
