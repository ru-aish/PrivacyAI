import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PRIVACY_MODEL,
  SessionVault,
  assertLocalPrivacyEndpoint,
  buildCodexHookDeclarationArgs,
  buildModelChoices,
  codexEffectiveCwd,
  consumeAllowance,
  listDownloadedLanguageModels,
  listLmStudioLanguageModels,
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

test("Ollama model discovery lists completion models and excludes embedding-only models", async () => {
  const models = await listDownloadedLanguageModels({
    fetch: async (url, init = {}) => {
      if (url.endsWith("/api/tags")) {
        return jsonResponse({
          models: [
            { name: "ministral-3:3b", size: 3_000_000_000, details: { parameter_size: "3.2B" } },
            { name: "bge-m3:latest", size: 1_200_000_000 },
            { name: "llama3.2:3b", size: 2_000_000_000 }
          ]
        });
      }

      const { model } = JSON.parse(init.body);
      if (model === "bge-m3:latest") {
        return jsonResponse({ capabilities: ["embedding"], details: { parameter_size: "567M" } });
      }
      return jsonResponse({
        capabilities: ["completion"],
        details: { parameter_size: model === "ministral-3:3b" ? "3.2B" : "3.0B", quantization_level: "Q4_K_M" }
      });
    }
  });

  assert.deepEqual(models.map(item => item.name), ["ministral-3:3b", "llama3.2:3b"]);
});

test("LM Studio discovery lists LLM and VLM models and excludes embeddings", async () => {
  const models = await listLmStudioLanguageModels({
    baseURL: "http://127.0.0.1:1234/v1",
    apiKey: "test-token",
    fetch: async (url, init = {}) => {
      assert.equal(url, "http://127.0.0.1:1234/api/v0/models");
      assert.equal(init.headers.authorization, "Bearer test-token");
      return jsonResponse({
        data: [
          {
            id: "mistralai/ministral-3-3b",
            type: "vlm",
            state: "loaded",
            quantization: "Q4_K_M",
            max_context_length: 262144
          },
          {
            id: "llama-3.2-3b-instruct",
            type: "llm",
            state: "not-loaded",
            quantization: "Q4_K_M",
            max_context_length: 131072
          },
          {
            id: "text-embedding-bge-m3",
            type: "embeddings",
            state: "not-loaded"
          }
        ]
      });
    }
  });

  assert.deepEqual(models.map(item => item.name), [
    "mistralai/ministral-3-3b",
    "llama-3.2-3b-instruct"
  ]);
  assert.equal(models[0].provider, "lm-studio");
  assert.equal(models[0].baseURL, "http://127.0.0.1:1234/v1");
  assert.equal(models[0].state, "loaded");
});

test("a downloaded LM Studio Ministral outranks an unavailable Ollama default", () => {
  const choices = buildModelChoices(
    [],
    [{ name: "mistralai/ministral-3-3b", state: "loaded", type: "vlm" }],
    { includeOllamaDefault: true }
  );

  assert.equal(choices[0].provider, "lm-studio");
  assert.equal(choices[0].name, "mistralai/ministral-3-3b");
  assert.equal(choices[0].recommended, true);
  assert.equal(choices[1].provider, "ollama");
  assert.equal(choices[1].downloaded, false);
});

test("onboarding shows Ollama and LM Studio models in one numbered menu", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-onboard-multi-provider-"));
  const configPath = join(root, "config.json");
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });

  await runOnboarding({
    configPath,
    ollamaPath: "/test/ollama",
    ask: async () => "2",
    output,
    listModels: async () => ["ministral-3:3b"],
    listLmStudioModels: async () => [
      {
        name: "mistralai/ministral-3-3b",
        type: "vlm",
        state: "loaded",
        quantizationLevel: "Q4_K_M",
        maxContextLength: 262144
      },
      {
        name: "llama-3.2-3b-instruct",
        type: "llm",
        state: "not-loaded",
        quantizationLevel: "Q4_K_M",
        maxContextLength: 131072
      }
    ],
    fetch: async url => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "mistralai/ministral-3-3b" }] });
      }
      return jsonResponse({ models: [{ name: "ministral-3:3b" }] });
    }
  });

  const loaded = await loadPrivacyConfig({ path: configPath });
  assert.equal(loaded.config.provider, "lm-studio");
  assert.equal(loaded.config.model, "mistralai/ministral-3-3b");
  assert.equal(loaded.config.baseURL, "http://127.0.0.1:1234/v1");
  assert.match(text, /1\. ministral-3:3b \(recommended, Ollama, downloaded/);
  assert.match(text, /2\. mistralai\/ministral-3-3b \(LM Studio, loaded, VLM, Q4_K_M, 262K ctx/);
  assert.match(text, /3\. llama-3\.2-3b-instruct \(LM Studio, not-loaded, LLM/);
  assert.match(text, /Using LM Studio privacy model: mistralai\/ministral-3-3b/);
});

test("LM Studio-only onboarding works when Ollama is not installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-onboard-lm-only-"));
  const configPath = join(root, "config.json");

  await runOnboarding({
    configPath,
    ollamaPath: null,
    ask: async () => "",
    output: new PassThrough(),
    listLmStudioModels: async () => [
      { name: "mistralai/ministral-3-3b", type: "vlm", state: "loaded" }
    ],
    fetch: async () => jsonResponse({ data: [{ id: "mistralai/ministral-3-3b" }] })
  });

  const loaded = await loadPrivacyConfig({ path: configPath });
  assert.equal(loaded.config.provider, "lm-studio");
  assert.equal(loaded.config.model, "mistralai/ministral-3-3b");
});

test("onboarding recommends Ministral 3 3B and shows every downloaded language model", async () => {
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
    listModels: async () => [
      { name: "llama3.2:3b", parameterSize: "3.0B", capabilities: ["completion"] },
      { name: "ministral-3:3b", parameterSize: "3.2B", capabilities: ["completion"] }
    ],
    listLmStudioModels: async () => [],
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return 0;
    },
    fetch: async () => jsonResponse({ models: [{ name: "ministral-3:3b" }] })
  });

  assert.deepEqual(commands, []);
  const loaded = await loadPrivacyConfig({ path: configPath });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.config.model, DEFAULT_PRIVACY_MODEL);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.match(text, /1\. ministral-3:3b \(recommended, Ollama, downloaded/);
  assert.match(text, /2\. llama3\.2:3b \(Ollama, downloaded/);
  assert.match(text, /Using Ollama privacy model: ministral-3:3b/);
  assert.match(text, /privacyai claude/);
  assert.match(text, /github.com\/ru-aish\/PrivacyAI/);
});

test("onboarding pulls the recommended Ministral model when it is not downloaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-onboard-default-pull-"));
  const configPath = join(root, "config.json");
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
    listModels: async () => ["llama3.2:3b"],
    listLmStudioModels: async () => [],
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return 0;
    },
    fetch: async () => jsonResponse({ models: [{ name: "ministral-3:3b" }] })
  });

  assert.deepEqual(commands, [["/test/ollama", ["pull", "ministral-3:3b"]]]);
  assert.match(text, /1\. ministral-3:3b \(recommended, Ollama, not downloaded/);
  assert.equal((await loadPrivacyConfig({ path: configPath })).config.model, DEFAULT_PRIVACY_MODEL);
});

test("onboarding can select a downloaded model by number without pulling it", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-onboard-choice-"));
  const configPath = join(root, "config.json");
  const commands = [];

  await runOnboarding({
    configPath,
    ollamaPath: "/test/ollama",
    ask: async () => "2",
    output: new PassThrough(),
    listModels: async () => ["ministral-3:3b", "llama3.2:3b"],
    listLmStudioModels: async () => [],
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return 0;
    },
    fetch: async () => jsonResponse({ models: [{ name: "llama3.2:3b" }] })
  });

  assert.deepEqual(commands, []);
  assert.equal((await loadPrivacyConfig({ path: configPath })).config.model, "llama3.2:3b");
});

test("onboarding pulls a model name that is not downloaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-onboard-custom-"));
  const configPath = join(root, "config.json");
  const commands = [];

  await runOnboarding({
    configPath,
    ollamaPath: "/test/ollama",
    ask: async () => "custom-private-model:latest",
    output: new PassThrough(),
    listModels: async () => ["ministral-3:3b"],
    listLmStudioModels: async () => [],
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return 0;
    },
    fetch: async () => jsonResponse({ models: [{ name: "custom-private-model:latest" }] })
  });

  assert.deepEqual(commands, [["/test/ollama", ["pull", "custom-private-model:latest"]]]);
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

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return body;
    }
  };
}

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
