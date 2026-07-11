import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SessionVault,
  assertLocalPrivacyEndpoint,
  buildCodexHookDeclarationArgs,
  codexEffectiveCwd,
  consumeAllowance,
  loadPrivacyConfig,
  processPromptSubmission,
  rebaseSessionAdditions,
  runOnboarding,
  validateNativeArguments
} from "../src/index.js";

const PTY_HELPER = fileURLToPath(new URL("../bin/privacyai-pty.py", import.meta.url));

test("prompt submission blocks raw text, stores the map, and allows only the reinjected prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-prompt-flow-"));
  const runtimeDir = join(root, "runtime");
  const vault = new SessionVault({ baseDir: join(root, "vault") });
  await mkdir(runtimeDir, { mode: 0o700 });
  let sanitizerCalls = 0;

  const first = await processPromptSubmission(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-session-1",
      prompt: "Store DEMO_PRIVATE_VALUE in .env"
    },
    {
      runtimeDir,
      vault,
      sanitizer: async prompt => {
        sanitizerCalls += 1;
        return {
          sanitizedPrompt: prompt.replace("DEMO_PRIVATE_VALUE", "[API_KEY_1]"),
          sessionMap: { "[API_KEY_1]": "DEMO_PRIVATE_VALUE" }
        };
      }
    }
  );

  assert.equal(first.output.decision, "block");
  assert.match(first.output.reason, /PRIVACYAI_REINJECT/);
  assert.equal(sanitizerCalls, 1);

  const pendingPath = join(runtimeDir, "pending", `${first.id}.json`);
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  assert.equal(pending.sanitizedPrompt, "Store [API_KEY_1] in .env");
  assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
  assert.deepEqual((await vault.load("native-session-1")).sessionMap, {
    "[API_KEY_1]": "DEMO_PRIVATE_VALUE"
  });

  const second = await processPromptSubmission(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-session-1",
      prompt: first.sanitizedPrompt
    },
    {
      runtimeDir,
      vault,
      sanitizer: async () => {
        sanitizerCalls += 1;
        throw new Error("reinjected prompt must not be sanitized twice");
      }
    }
  );

  assert.equal(second, null);
  assert.equal(sanitizerCalls, 1);
  assert.equal(await consumeAllowance(runtimeDir, "native-session-1", first.sanitizedPrompt), false);
});

test("session placeholder collisions are rebased across turns", () => {
  const result = rebaseSessionAdditions(
    "Use [API_KEY_1] and Alex Morgan",
    { "[API_KEY_1]": "second-secret", "Alex Morgan": "Second Person" },
    { "[API_KEY_1]": "first-secret", "Alex Morgan": "First Person", "[PRIVATE_VALUE_1]": "Reserved" }
  );
  assert.equal(result.sanitizedPrompt, "Use [API_KEY_2] and [PRIVATE_VALUE_2]");
  assert.deepEqual(result.sessionMap, {
    "[API_KEY_2]": "second-secret",
    "[PRIVATE_VALUE_2]": "Second Person"
  });
});

test("remote sanitizer endpoints are rejected unless explicitly allowed", () => {
  assert.doesNotThrow(() => assertLocalPrivacyEndpoint("http://127.0.0.1:11434"));
  assert.doesNotThrow(() => assertLocalPrivacyEndpoint("http://localhost:11434"));
  assert.throws(() => assertLocalPrivacyEndpoint("https://privacy.example.com/v1"), /remote sanitizer endpoint/);
  assert.doesNotThrow(() =>
    assertLocalPrivacyEndpoint("https://privacy.example.com/v1", { allowRemote: true })
  );
});

test("argument guards reject flags that can replace privacy hooks", () => {
  assert.throws(() => validateNativeArguments("claude", ["--settings", "other.json"]), /privacy hooks/);
  assert.throws(() => validateNativeArguments("codex", ["--disable", "hooks"]), /hooks disabled/);
  assert.throws(() => validateNativeArguments("codex", ["-c", "hooks.UserPromptSubmit=[]"]), /reserves/);
  assert.doesNotThrow(() => validateNativeArguments("claude", ["--model", "sonnet"]));
});

test("native slash commands without arguments bypass prompt sanitization", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "privacyai-slash-"));
  const result = await processPromptSubmission(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-session-2",
      prompt: "/model"
    },
    {
      runtimeDir,
      sanitizer: async () => {
        throw new Error("slash command should stay native");
      }
    }
  );
  assert.equal(result, null);

  let called = false;
  await processPromptSubmission(
    { hook_event_name: "UserPromptSubmit", session_id: "native-session-3", prompt: "/review DEMO_PRIVATE_VALUE" },
    {
      runtimeDir,
      sanitizer: async prompt => {
        called = true;
        return { sanitizedPrompt: prompt.replace("DEMO_PRIVATE_VALUE", "[API_KEY_1]"), sessionMap: { "[API_KEY_1]": "DEMO_PRIVATE_VALUE" } };
      }
    }
  );
  assert.equal(called, true);
});

test("onboarding downloads the chosen model and writes a private config", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-onboard-"));
  const configPath = join(root, "config", "config.json");
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });
  const commands = [];

  await runOnboarding({
    configPath,
    ollamaPath: "/test/ollama",
    ask: async () => "",
    output,
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return 0;
    },
    fetch: async () => ({
      ok: true,
      async json() {
        return { models: [{ name: "qwen3.5:2b" }] };
      }
    })
  });

  assert.deepEqual(commands, [["/test/ollama", ["pull", "qwen3.5:2b"]]]);
  const loaded = await loadPrivacyConfig({ path: configPath });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.config.model, "qwen3.5:2b");
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.match(text, /privacyai claude/);
  assert.match(text, /github.com\/ru-aish\/PrivacyAI/);
});

test("Codex hook arguments declare prompt and Bash lifecycle hooks", () => {
  const args = buildCodexHookDeclarationArgs({ nodePath: "/usr/bin/node" });
  const joined = args.join(" ");
  assert.match(joined, /UserPromptSubmit/);
  assert.match(joined, /PreToolUse/);
  assert.match(joined, /PostToolUse/);
  assert.match(joined, /\^Bash\$/);
  assert.equal(codexEffectiveCwd(["resume", "--last", "-C", "/tmp/project"]), "/tmp/project");
});

test("Unix PTY helper reinjects a pending sanitized prompt into an unchanged child TUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-pty-"));
  const pendingDir = join(root, "pending");
  await mkdir(pendingDir, { mode: 0o700 });
  const id = "12345678-1234-1234-1234-123456789abc";
  await writeFile(
    join(pendingDir, `${id}.json`),
    JSON.stringify({ sanitizedPrompt: "Use [API_KEY_1] now" }),
    { mode: 0o600 }
  );

  const fakeTui = join(root, "fake-tui.py");
  await writeFile(
    fakeTui,
    [
      "import os,sys",
      `print('[PRIVACYAI_REINJECT:${id}]', flush=True)`,
      "data=b''",
      "while not data.endswith((b'\\r', b'\\n')):",
      "    chunk=os.read(sys.stdin.fileno(), 1)",
      "    if not chunk: break",
      "    data += chunk",
      "data=data.replace(b'\\x1b[200~',b'').replace(b'\\x1b[201~',b'').rstrip(b'\\r\\n')",
      "print('RECEIVED:'+data.decode(), flush=True)"
    ].join("\n")
  );

  const result = await runProcess("python3", [
    PTY_HELPER,
    "--runtime-dir",
    root,
    "--flavor",
    "codex",
    "--",
    "python3",
    fakeTui
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /RECEIVED:Use \[API_KEY_1\] now/);
});

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", code => resolve({ code, stdout, stderr }));
  });
}
