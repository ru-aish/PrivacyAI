import { createTestTempDir } from "./test-temp-dir.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PRIVACY_MODEL,
  MemoryContextVerificationStore,
  SessionVault,
  assertLocalPrivacyEndpoint,
  assertNoProtectedOriginals,
  auditClaudeStartupContext,
  auditCodexStartupContext,
  auditCodexStaticStartupContext,
  buildCodexHookDeclarationArgs,
  captureCodexPromptInput,
  buildCodexIsolationArgs,
  buildModelChoices,
  codexEffectiveCwd,
  consumeAllowance,
  listDownloadedLanguageModels,
  listLmStudioLanguageModels,
  loadPrivacyConfig,
  prepareAgentRuntimeIsolation,
  processPromptSubmission,
  rebaseSessionAdditions,
  resolveCodexCaptureTimeoutMs,
  runOnboarding,
  sanitizeCodexRequestBody,
  validateNativeArguments,
  validateNativeEnvironment,
  writeClaudeSettings
} from "../src/index.js";

const PTY_HELPER = fileURLToPath(new URL("../bin/privacyai-pty.py", import.meta.url));

test("prompt submission blocks raw text, stores the map, and allows only the reinjected prompt", async () => {
  const root = await createTestTempDir("privacyai-prompt-flow-");
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

test("clean prompts do not create empty session-vault records", async () => {
  const root = await createTestTempDir("privacyai-clean-prompt-");
  const runtimeDir = join(root, "runtime");
  const vault = new SessionVault({ baseDir: join(root, "vault") });
  await mkdir(runtimeDir, { mode: 0o700 });

  const result = await processPromptSubmission(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "clean-session",
      prompt: "Explain this public algorithm"
    },
    {
      runtimeDir,
      vault,
      sanitizer: async prompt => ({ sanitizedPrompt: prompt, sessionMap: {} })
    }
  );

  assert.equal(result, null);
  await assert.rejects(stat(vault.pathForSession("clean-session")), /ENOENT/);
});

test("prompt flow fails closed when a sanitizer mapping leaves its original in provider text", async () => {
  const root = await createTestTempDir("privacyai-prompt-leak-");
  const runtimeDir = join(root, "runtime");
  const vault = new SessionVault({ baseDir: join(root, "vault") });
  await mkdir(runtimeDir, { mode: 0o700 });

  await assert.rejects(
    processPromptSubmission(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "leaking-session",
        prompt: "Use prompt.secret@example.test"
      },
      {
        runtimeDir,
        vault,
        sanitizer: async prompt => ({
          sanitizedPrompt: prompt,
          sessionMap: { "[EMAIL_1]": "prompt.secret@example.test" }
        })
      }
    ),
    error => {
      assert.equal(error.code, "PRIVACYAI_PROMPT_LEAK");
      assert.doesNotMatch(error.message, /prompt\.secret@example\.test/);
      return true;
    }
  );
  await assert.rejects(stat(vault.pathForSession("leaking-session")), /ENOENT/);
});

test("known values from earlier turns cannot pass through a later no-op sanitizer result", async () => {
  const root = await createTestTempDir("privacyai-known-prompt-leak-");
  const runtimeDir = join(root, "runtime");
  const vault = new SessionVault({ baseDir: join(root, "vault") });
  await mkdir(runtimeDir, { mode: 0o700 });
  await vault.save("known-session", {
    "[EMAIL_1]": "known.secret@example.test"
  });

  await assert.rejects(
    processPromptSubmission(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "known-session",
        prompt: "Use known.secret@example.test again"
      },
      {
        runtimeDir,
        vault,
        sanitizer: async prompt => ({ sanitizedPrompt: prompt, sessionMap: {} })
      }
    ),
    error => error?.code === "PRIVACYAI_PROMPT_LEAK"
  );
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
  assert.doesNotThrow(() => assertLocalPrivacyEndpoint("http://127.25.10.9:11434"));
  assert.doesNotThrow(() => assertLocalPrivacyEndpoint("http://[::1]:11434"));
  assert.throws(() => assertLocalPrivacyEndpoint("http://127.evil.example:11434"), /remote sanitizer endpoint/);
  assert.throws(() => assertLocalPrivacyEndpoint("http://127.0.0.1.evil.example:11434"), /remote sanitizer endpoint/);
  assert.throws(() => assertLocalPrivacyEndpoint("https://privacy.example.com/v1"), /remote sanitizer endpoint/);
  assert.doesNotThrow(() =>
    assertLocalPrivacyEndpoint("https://privacy.example.com/v1", { allowRemote: true })
  );
});

test("argument guards preserve normal Codex workflows while blocking provider bypasses", () => {
  assert.throws(() => validateNativeArguments("claude", ["--settings", "other.json"]), /privacy hooks/);
  assert.throws(() => validateNativeArguments("claude", ["--bare"]), /disables privacy hooks/);
  assert.throws(() => validateNativeArguments("claude", ["--safe-mode"]), /disables privacy hooks/);

  assert.doesNotThrow(() => validateNativeArguments("codex", ["resume", "--last"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["fork", "--last"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["exec", "hello"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["review"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["--add-dir", "../shared"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["--enable", "shell_tool"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["-c", "model_reasoning_effort=\"high\""]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["--model", "resume"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["--", "resume"]));

  assert.throws(() => validateNativeArguments("codex", ["--remote", "unix:///tmp/server"]), /not protected by the local provider gateway/);
  assert.throws(() => validateNativeArguments("codex", ["--search"]), /not protected/);
  assert.doesNotThrow(() => validateNativeArguments("codex", ["--image", "private.png"]));
  assert.doesNotThrow(() => validateNativeArguments("codex", ["-i", "private.png"]));
  assert.throws(() => validateNativeArguments("codex", ["--profile", "unsafe"]), /not protected/);
  assert.throws(() => validateNativeArguments("codex", ["-c", "model_provider=\"other\""]), /model-provider/);
  assert.throws(() => validateNativeArguments("codex", ["--config", "openai_base_url=\"https://example.test\""]), /model-provider/);
  assert.throws(() => validateNativeArguments("codex", ["--enable", "responses_websockets"]), /bypasses local restoration/);
  assert.throws(() => validateNativeArguments("codex", ["-c", "features.apps=true"]), /provider-hosted/);
  assert.throws(() => validateNativeArguments("codex", ["-ip"]), /combined or attached Codex short options/);
  assert.throws(() => validateNativeArguments("codex", ["-mresume"]), /combined or attached Codex short options/);

  const strict = { codexMode: "strict" };
  assert.throws(() => validateNativeArguments("codex", ["--disable", "hooks"], strict), /hooks disabled/);
  assert.throws(() => validateNativeArguments("codex", ["-c", "hooks.UserPromptSubmit=[]"], strict), /reserves/);
  assert.throws(() => validateNativeArguments("codex", ["resume", "--last"], strict), /fresh-session boundary/);
  assert.throws(() => validateNativeArguments("codex", ["--enable", "shell_tool"], strict), /cannot enable/);
  assert.throws(() => validateNativeArguments("codex", ["--image", "private.png"], strict), /prompt-only isolation/);

  assert.throws(() => validateNativeArguments("claude", ["--resume", "session"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["--plugin-dir", "plugin"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["--plugin-url", "https://example.test/plugin.zip"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["--add-dir", "../private"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["--system-prompt-file", "private.txt"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["--allowed-tools", "Read"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["--remote-control"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["--bg", "task"]), /isolated startup context/);
  assert.throws(() => validateNativeArguments("claude", ["-pr"]), /combined or attached Claude short options/);
  assert.throws(() => validateNativeArguments("claude", ["-msonnet"]), /combined or attached Claude short options/);
  assert.doesNotThrow(() => validateNativeArguments("claude", ["--model", "sonnet"]));
  assert.doesNotThrow(() => validateNativeArguments("claude", ["--", "-pr"]));
});

test("Claude environment guards reject hook-disabling modes", () => {
  assert.throws(
    () => validateNativeEnvironment("claude", { CLAUDE_CODE_SIMPLE: "1" }),
    /CLAUDE_CODE_SIMPLE disables privacy hooks/
  );
  assert.throws(
    () => validateNativeEnvironment("claude", { CLAUDE_CODE_SAFE_MODE: "true" }),
    /CLAUDE_CODE_SAFE_MODE disables privacy hooks/
  );
  assert.doesNotThrow(() =>
    validateNativeEnvironment("claude", {
      CLAUDE_CODE_SIMPLE: "0",
      CLAUDE_CODE_SAFE_MODE: "false"
    })
  );
  assert.doesNotThrow(() => validateNativeEnvironment("codex", { CLAUDE_CODE_SIMPLE: "1" }));
});

test("only non-contextual native slash commands bypass prompt sanitization", async t => {
  const runtimeDir = await createTestTempDir("privacyai-slash-");
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
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
  const blocked = await processPromptSubmission(
    { hook_event_name: "UserPromptSubmit", session_id: "native-session-3", prompt: "/review DEMO_PRIVATE_VALUE" },
    {
      runtimeDir,
      sanitizer: async () => {
        called = true;
        throw new Error("context-loading slash command must be blocked before sanitization");
      }
    }
  );
  assert.equal(called, false);
  assert.equal(blocked.output.decision, "block");
  assert.match(blocked.output.reason, /inject files, history, diffs/);

  for (const prompt of [
    "Summarize @README.md",
    "Inspect @src/config.ts",
    "Read @Dockerfile",
    "Compare @LICENSE",
    "Ask @alice",
    "!cat .env"
  ]) {
    const ingress = await processPromptSubmission(
      { hook_event_name: "UserPromptSubmit", session_id: `native-ingress-${prompt}`, prompt },
      { runtimeDir, sanitizer: async () => { throw new Error("native ingress must not reach sanitizer"); } }
    );
    assert.equal(ingress.output.decision, "block");
    assert.match(ingress.output.reason, /expands it after prompt sanitization/);
  }

  const ordinaryEmail = await processPromptSubmission(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "ordinary-email",
      prompt: "Email user@example.test"
    },
    {
      runtimeDir,
      sanitizer: async prompt => ({ sanitizedPrompt: prompt, sessionMap: {} })
    }
  );
  assert.equal(ordinaryEmail, null);
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
  const root = await createTestTempDir("privacyai-onboard-multi-provider-");
  const configPath = join(root, "config.json");
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });

  await runOnboarding({
    configPath,
    skipHealthCheck: true,
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
  const root = await createTestTempDir("privacyai-onboard-lm-only-");
  const configPath = join(root, "config.json");

  await runOnboarding({
    configPath,
    skipHealthCheck: true,
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
  const root = await createTestTempDir("privacyai-onboard-");
  const configPath = join(root, "config", "config.json");
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });
  const commands = [];

  await runOnboarding({
    configPath,
    skipHealthCheck: true,
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
  const root = await createTestTempDir("privacyai-onboard-default-pull-");
  const configPath = join(root, "config.json");
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });
  const commands = [];

  await runOnboarding({
    configPath,
    skipHealthCheck: true,
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
  const root = await createTestTempDir("privacyai-onboard-choice-");
  const configPath = join(root, "config.json");
  const commands = [];

  await runOnboarding({
    configPath,
    skipHealthCheck: true,
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
  const root = await createTestTempDir("privacyai-onboard-custom-");
  const configPath = join(root, "config.json");
  const commands = [];

  await runOnboarding({
    configPath,
    skipHealthCheck: true,
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


test("runtime isolation copies only credential material into private agent homes", async () => {
  const root = await createTestTempDir("privacyai-runtime-isolation-");
  const runtimeDir = join(root, "runtime");
  const codexSource = join(root, "codex-source");
  const claudeSource = join(root, "claude-source");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(codexSource, { recursive: true, mode: 0o700 });
  await mkdir(claudeSource, { recursive: true, mode: 0o700 });
  await writeFile(join(codexSource, "auth.json"), '{"token":"local-only"}\n', { mode: 0o600 });
  await writeFile(join(codexSource, "AGENTS.md"), "DO_NOT_COPY_THIS_CONTEXT\n", { mode: 0o600 });
  await writeFile(join(claudeSource, ".credentials.json"), '{"token":"local-only"}\n', { mode: 0o600 });
  await writeFile(join(claudeSource, "CLAUDE.md"), "DO_NOT_COPY_THIS_CONTEXT\n", { mode: 0o600 });

  const codex = await prepareAgentRuntimeIsolation("codex", runtimeDir, { codexHome: codexSource });
  assert.equal(JSON.parse(await readFile(join(codex.targetHome, "auth.json"), "utf8")).token, "local-only");
  await assert.rejects(readFile(join(codex.targetHome, "AGENTS.md"), "utf8"), /ENOENT/);
  assert.equal((await stat(codex.targetHome)).mode & 0o777, 0o700);
  assert.equal((await stat(join(codex.targetHome, "auth.json"))).mode & 0o777, 0o600);
  assert.deepEqual(codex.args, buildCodexIsolationArgs());

  const claude = await prepareAgentRuntimeIsolation("claude", runtimeDir, {
    claudeConfigDir: claudeSource
  });
  assert.equal(
    JSON.parse(await readFile(join(claude.targetHome, ".credentials.json"), "utf8")).token,
    "local-only"
  );
  await assert.rejects(readFile(join(claude.targetHome, "CLAUDE.md"), "utf8"), /ENOENT/);
  assert.equal(await readFile(claude.emptyMcpPath, "utf8"), "{}\n");
  assert.deepEqual(claude.args.slice(0, 2), ["--setting-sources", "user"]);
  assert.equal(claude.args.includes("--strict-mcp-config"), true);
  assert.equal(claude.args.includes("--disable-slash-commands"), true);
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_ATTACHMENTS, "1");
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(claude.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");
  assert.equal(claude.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(claude.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(claude.env.OTEL_LOG_RAW_API_BODIES, "0");
  assert.equal(claude.env.OTEL_LOG_TOOL_DETAILS, "0");
  assert.equal(claude.env.OTEL_LOG_USER_PROMPTS, "0");
});

test("Codex startup capture drains UTF-8 output before parsing", async () => {
  const root = await createTestTempDir("privacyai-codex-capture-");
  const fakeCodex = join(root, "fake-codex.js");
  await writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "const prefix = Buffer.from('[{\"text\":\"');",
      "const euro = Buffer.from('€');",
      "const suffix = Buffer.from('\"}]');",
      "process.stdout.write(prefix);",
      "process.stdout.write(euro.subarray(0, 1));",
      "setTimeout(() => {",
      "  process.stdout.write(euro.subarray(1));",
      "  process.stdout.end(suffix);",
      "}, 5);"
    ].join("\n"),
    { mode: 0o755 }
  );
  await chmod(fakeCodex, 0o755);

  const result = await captureCodexPromptInput({
    codexPath: fakeCodex,
    args: [],
    cwd: root,
    env: process.env,
    prompt: "ignored",
    timeoutMs: 5000
  });
  assert.deepEqual(result, [{ text: "€" }]);
});

test("Codex startup capture reports an incomplete platform package", async () => {
  const root = await createTestTempDir("privacyai-codex-capture-broken-");
  const fakeCodex = join(root, "fake-codex.js");
  await writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "process.stderr.write('Error: Missing optional dependency @openai/codex-linux-x64.');",
      "process.exit(1);"
    ].join("\n"),
    { mode: 0o755 }
  );
  await chmod(fakeCodex, 0o755);

  await assert.rejects(
    captureCodexPromptInput({
      codexPath: fakeCodex,
      args: [],
      cwd: root,
      env: process.env,
      prompt: "ignored",
      timeoutMs: 5000
    }),
    error =>
      error?.code === "PRIVACYAI_CODEX_EXECUTABLE_BROKEN" &&
      error.message.includes("npm install -g @openai/codex@latest") &&
      !error.message.includes(root)
  );
});

test("Codex startup capture timeout follows configured MCP startup budgets", async () => {
  const root = await createTestTempDir("privacyai-codex-capture-timeout-");
  const codexHome = join(root, "codex-home");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    [
      "[mcp_servers.fast]",
      "command = \"fast\"",
      "startup_timeout_sec = 15",
      "",
      "[mcp_servers.slow]",
      "command = \"slow\"",
      "startup_timeout_sec = 120",
      "",
      "[mcp_servers.slow.env]",
      "PRIVATE_VALUE = \"ignored\""
    ].join("\n")
  );

  assert.equal(
    await resolveCodexCaptureTimeoutMs({
      cwd: root,
      env: { CODEX_HOME: codexHome }
    }),
    150000
  );
  assert.equal(
    await resolveCodexCaptureTimeoutMs({
      cwd: root,
      env: {
        CODEX_HOME: codexHome,
        PRIVACYAI_STARTUP_AUDIT_TIMEOUT_MS: "4321"
      }
    }),
    4321
  );
  assert.equal(
    await resolveCodexCaptureTimeoutMs({
      cwd: root,
      env: { CODEX_HOME: codexHome },
      timeoutMs: 1234
    }),
    1234
  );
});

test("Codex startup audit captures serialized model input and verifies the local canary", async () => {
  const audit = await auditCodexStartupContext({
    codexPath: "/test/codex",
    cwd: process.cwd(),
    canaryOriginal: "raw-provider-canary-secret",
    canaryPlaceholder: "[PRIVACYAI_PROVIDER_CANARY_TEST]",
    capture: async ({ prompt }) => [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "safe startup" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }
    ],
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} })
  });

  assert.equal(audit.itemCount, 2);
  assert.equal(audit.canaryPlaceholder, "[PRIVACYAI_PROVIDER_CANARY_TEST]");
  assert.equal(audit.serializedBytes > 0, true);
});

test("Codex startup audit ignores classifier false positives on synthetic canary shields", async () => {
  let sawBoundaryToken = false;
  const audit = await auditCodexStartupContext({
    codexPath: "/test/codex",
    cwd: process.cwd(),
    canaryOriginal: "raw-provider-canary-secret",
    canaryPlaceholder: "[PRIVACYAI_PROVIDER_CANARY_TEST]",
    capture: async ({ prompt }) => [{ prompt, instructions: "safe startup" }],
    sanitizer: async text => {
      const token = text.match(/__PRIVACYAI_BOUNDARY_\d+__/)?.[0];
      if (!token) return { sanitizedPrompt: text, sessionMap: {} };
      sawBoundaryToken = true;
      return {
        sanitizedPrompt: text.replaceAll(token, "[PRIVATE_VALUE_1]"),
        sessionMap: { "[PRIVATE_VALUE_1]": token }
      };
    },
    blockHighRisk: false
  });

  assert.equal(sawBoundaryToken, true);
  assert.deepEqual(audit.sessionMapAdditions, {});
});

test("Codex startup audit reuses a verified static manifest across canary rotations", async () => {
  const verificationStore = new MemoryContextVerificationStore();
  let sanitizerCalls = 0;
  const capture = async ({ prompt }) => [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "unchanged safe startup" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }
  ];
  const sanitizer = async text => {
    sanitizerCalls += 1;
    return { sanitizedPrompt: text, sessionMap: {} };
  };

  await auditCodexStartupContext({
    codexPath: "/test/codex",
    cwd: process.cwd(),
    canaryPlaceholder: "[PRIVACYAI_PROVIDER_CANARY_FIRST]",
    capture,
    sanitizer,
    verificationStore,
    policyFingerprint: "startup-policy-v1"
  });
  await auditCodexStartupContext({
    codexPath: "/test/codex",
    cwd: process.cwd(),
    canaryPlaceholder: "[PRIVACYAI_PROVIDER_CANARY_SECOND]",
    capture,
    sanitizer: async () => {
      throw new Error("unchanged startup context should use its trust manifest");
    },
    verificationStore,
    policyFingerprint: "startup-policy-v1"
  });

  assert.equal(sanitizerCalls, 1);
});

test("Codex startup audit fails if the serialized provider input contains its raw canary", async () => {
  await assert.rejects(
    auditCodexStartupContext({
      codexPath: "/test/codex",
      cwd: process.cwd(),
      canaryOriginal: "raw-provider-canary-secret",
      canaryPlaceholder: "[PRIVACYAI_PROVIDER_CANARY_TEST]",
      capture: async ({ prompt }) => [{ prompt, leaked: "raw-provider-canary-secret" }],
      sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} })
    }),
    error => error?.code === "PRIVACYAI_PROVIDER_PAYLOAD_LEAK"
  );
});

test("Codex startup audit blocks high-risk values already present in implicit context", async () => {
  await assert.rejects(
    auditCodexStartupContext({
      codexPath: "/test/codex",
      cwd: process.cwd(),
      capture: async ({ prompt }) => [{ prompt, instructions: "Contact startup.private@example.test" }],
      sanitizer: async text => ({
        sanitizedPrompt: text.replace("startup.private@example.test", "[EMAIL_1]"),
        sessionMap: { "[EMAIL_1]": "startup.private@example.test" }
      })
    }),
    error => error?.code === "PRIVACYAI_UNSAFE_STARTUP_CONTEXT" && error.detectionCount === 1
  );
});

test("Claude startup audit scans project instructions, skills, commands, agents, and plugins", async () => {
  const root = await createTestTempDir("privacyai-claude-startup-");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, ".claude", "skills", "private-skill"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "Safe project instructions\n");
  await writeFile(
    join(root, ".claude", "skills", "private-skill", "SKILL.md"),
    "Owner: startup.private@example.test\n"
  );

  await assert.rejects(
    auditClaudeStartupContext({
      cwd: root,
      sanitizer: async text => ({
        sanitizedPrompt: text.replace("startup.private@example.test", "[EMAIL_1]"),
        sessionMap: { "[EMAIL_1]": "startup.private@example.test" }
      })
    }),
    error => error?.code === "PRIVACYAI_UNSAFE_STARTUP_CONTEXT"
  );
});

test("Claude startup audit reuses unchanged files without reads or sanitizer calls", async () => {
  const root = await createTestTempDir("privacyai-claude-startup-cache-");
  await mkdir(join(root, ".git"), { recursive: true });
  const instructions = join(root, "CLAUDE.md");
  await writeFile(instructions, "Safe project instructions\n");

  const verificationStore = new MemoryContextVerificationStore();
  let sanitizerCalls = 0;
  const sanitizer = async text => {
    sanitizerCalls += 1;
    return { sanitizedPrompt: text, sessionMap: {} };
  };
  const options = {
    cwd: root,
    sanitizer,
    verificationStore,
    policyFingerprint: "sha256:claude-startup-cache-policy"
  };

  const cold = await auditClaudeStartupContext(options);
  assert.equal(cold.counters.reads, 1);
  assert.equal(cold.counters.sanitizerCalls, 1);
  assert.equal(sanitizerCalls, 1);

  const warm = await auditClaudeStartupContext(options);
  assert.equal(warm.manifestHash, cold.manifestHash);
  assert.equal(warm.counters.metadataHits, 1);
  assert.equal(warm.counters.reads, 0);
  assert.equal(warm.counters.sanitizerCalls, 0);
  assert.equal(sanitizerCalls, 1);

  await writeFile(instructions, "Changed safe project instructions\n");
  const changed = await auditClaudeStartupContext(options);
  assert.notEqual(changed.manifestHash, cold.manifestHash);
  assert.equal(changed.counters.reads, 1);
  assert.equal(changed.counters.sanitizerCalls, 1);
  assert.equal(sanitizerCalls, 2);
});

test("startup directory traversal is bounded even when directories contain no files", async t => {
  const root = await createTestTempDir("privacyai-startup-traversal-limit-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"), { recursive: true });
  const claudeSkills = join(root, ".claude", "skills");
  const codexSkills = join(root, ".codex", "skills");
  await mkdir(claudeSkills, { recursive: true });
  await mkdir(codexSkills, { recursive: true });
  await Promise.all(Array.from({ length: 321 }, (_, index) => Promise.all([
    mkdir(join(claudeSkills, "empty-" + index)),
    mkdir(join(codexSkills, "empty-" + index))
  ])));

  await assert.rejects(
    auditClaudeStartupContext({
      cwd: root,
      maxFiles: 10,
      maxContextChars: 1024,
      sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} })
    }),
    error => error?.code === "PRIVACYAI_STARTUP_CONTEXT_TOO_LARGE"
  );

  await assert.rejects(
    auditCodexStaticStartupContext({
      cwd: root,
      projectRoot: root,
      codexHome: join(root, "codex-home"),
      maxFiles: 10,
      maxBytes: 1024,
      staticSanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} })
    }),
    error => error?.code === "PRIVACYAI_STARTUP_CONTEXT_TOO_LARGE"
  );
});

test("provider-bound assertion never includes the protected value in diagnostics", () => {
  const secret = "do-not-print-this-provider-secret";
  assert.throws(
    () => assertNoProtectedOriginals(`payload=${secret}`, { "[API_KEY_1]": secret }),
    error => {
      assert.equal(error.code, "PRIVACYAI_PROVIDER_PAYLOAD_LEAK");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
});

test("native hook declarations cover every built-in, app, plugin, and MCP tool", async () => {
  const root = await createTestTempDir("privacyai-all-tool-hooks-");
  const settingsPath = join(root, "claude-settings.json");
  const settings = await writeClaudeSettings(settingsPath, { nodePath: "/usr/bin/node" });
  assert.equal(settings.disableAllHooks, false);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
  assert.equal(settings.hooks.PostToolUse[0].matcher, "*");
  assert.equal(settings.hooks.PostToolUseFailure[0].matcher, "*");
  assert.equal(settings.hooks.PostToolUseFailure[0].hooks[0].timeout, 30);
  assert.equal(settings.hooks.PostToolBatch[0].matcher, undefined);

  const args = buildCodexHookDeclarationArgs({ nodePath: "/usr/bin/node" });
  const joined = args.join(" ");
  assert.match(joined, /UserPromptSubmit/);
  assert.match(joined, /PreToolUse/);
  assert.match(joined, /PostToolUse/);
  assert.match(joined, /\^\.\*\$/);
  assert.doesNotMatch(joined, /\^Bash\$/);
  assert.equal(codexEffectiveCwd(["resume", "--last", "-C", "/tmp/project"]), "/tmp/project");
});

test("Unix PTY helper reinjects a pending sanitized prompt into an unchanged child TUI", async () => {
  const root = await createTestTempDir("privacyai-pty-");
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

test("Unix PTY helper converts exact Codex session commands into private launcher actions", async () => {
  const root = await createTestTempDir("privacyai-pty-session-action-");
  const actionPath = join(root, "action.json");
  const input = "/resume --last" + String.fromCharCode(13);

  const result = await runProcessWithInput("python3", [
    PTY_HELPER,
    "--runtime-dir",
    root,
    "--flavor",
    "codex",
    "--session-action-file",
    actionPath,
    "--",
    "/bin/cat"
  ], input);

  assert.equal(result.code, 86);
  assert.deepEqual(JSON.parse(await readFile(actionPath, "utf8")), {
    version: 1,
    action: "resume",
    selector: "--last"
  });
  assert.equal((await stat(actionPath)).mode & 0o777, 0o600);

  const terminalActionPath = join(root, "terminal-action.json");
  const terminalInput =
    String.fromCharCode(27) + "[?1;2c" +
    String.fromCharCode(27) + "]10;rgb:0000/0000/0000" +
    String.fromCharCode(27) + "\\" +
    "/resume --all" + String.fromCharCode(13);
  const terminalResult = await runProcessWithInput("python3", [
    PTY_HELPER,
    "--runtime-dir",
    root,
    "--flavor",
    "codex",
    "--session-action-file",
    terminalActionPath,
    "--",
    "/bin/cat"
  ], terminalInput);

  assert.equal(terminalResult.code, 86);
  assert.deepEqual(JSON.parse(await readFile(terminalActionPath, "utf8")), {
    version: 1,
    action: "resume",
    selector: "--all"
  });

  const forkActionPath = join(root, "fork-action.json");
  const forkInput = String.fromCharCode(27) + "/fork --all" + String.fromCharCode(13);
  const forkResult = await runProcessWithInput("python3", [
    PTY_HELPER,
    "--runtime-dir",
    root,
    "--flavor",
    "codex",
    "--session-action-file",
    forkActionPath,
    "--",
    "/bin/cat"
  ], forkInput);

  assert.equal(forkResult.code, 86);
  assert.deepEqual(JSON.parse(await readFile(forkActionPath, "utf8")), {
    version: 1,
    action: "fork",
    selector: "--all"
  });

  const navigationActionPath = join(root, "navigation-action.json");
  const finiteTui = join(root, "finite-tui.py");
  await writeFile(
    finiteTui,
    [
      "import os,sys",
      "data=b''",
      "while not data.endswith((b'\\r', b'\\n')):",
      "    chunk=os.read(sys.stdin.fileno(), 1)",
      "    if not chunk: break",
      "    data += chunk",
      "print('FORWARDED:'+data.hex(), flush=True)"
    ].join("\n")
  );
  const navigationInput =
    "draft" + String.fromCharCode(27) + "[D" + "/resume --last" + String.fromCharCode(13);
  const navigationResult = await runProcessWithInput("python3", [
    PTY_HELPER,
    "--runtime-dir",
    root,
    "--flavor",
    "codex",
    "--session-action-file",
    navigationActionPath,
    "--",
    "python3",
    finiteTui
  ], navigationInput);

  assert.equal(navigationResult.code, 0);
  await assert.rejects(readFile(navigationActionPath, "utf8"), /ENOENT/);
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

function runProcessWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(input);
  });
}


test("Codex static preflight detects home and project startup files without spawning Codex or the AI sanitizer", async () => {
  const root = await createTestTempDir("privacyai-codex-static-preflight-");
  const codexHome = join(root, "codex-home");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(codexHome, "skills", "private-skill"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Safe project instructions.\n");
  await writeFile(
    join(codexHome, "skills", "private-skill", "SKILL.md"),
    "Contact startup.private@example.test before launch.\n"
  );

  let calls = 0;
  const sanitizer = async text => {
    calls += 1;
    return {
      sanitizedPrompt: text.replaceAll("startup.private@example.test", "[EMAIL_1]"),
      sessionMap: text.includes("startup.private@example.test")
        ? { "[EMAIL_1]": "startup.private@example.test" }
        : {}
    };
  };
  const store = new MemoryContextVerificationStore();
  const result = await auditCodexStaticStartupContext({
    cwd: root,
    env: { CODEX_HOME: codexHome },
    staticSanitizer: sanitizer,
    verificationStore: store,
    policyFingerprint: "static-preflight-v1",
    blockHighRisk: false,
    maxContextChars: 4096,
    maxBytes: 100000
  });

  assert.equal(result.fileCount, 2);
  assert.equal(calls > 0, true);
  assert.equal(result.sessionMapAdditions["[EMAIL_1]"], "startup.private@example.test");

  await assert.rejects(
    auditCodexStaticStartupContext({
      cwd: root,
      env: { CODEX_HOME: codexHome },
      sanitizer: async () => {
        throw new Error("static preflight must not call the AI sanitizer");
      },
      staticSanitizer: sanitizer,
      verificationStore: store,
      policyFingerprint: "static-preflight-v1",
      blockHighRisk: true,
      maxContextChars: 4096,
      maxBytes: 100000
    }),
    error => error?.code === "PRIVACYAI_UNSAFE_STARTUP_CONTEXT"
  );
});

test("rendered Codex startup audit primes exact gateway item verification", async () => {
  const store = new MemoryContextVerificationStore();
  const policyFingerprint = "rendered-preflight-v1";
  let capturedPayload;
  const result = await auditCodexStartupContext({
    codexPath: "/test/codex",
    cwd: process.cwd(),
    capture: async ({ prompt }) => {
      capturedPayload = [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "stable rendered startup instructions" }]
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      ];
      return capturedPayload;
    },
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    verificationStore: store,
    policyFingerprint,
    blockHighRisk: false,
    primeRequestCache: true
  });

  assert.equal(result.primedItemCount, 2);
  assert.deepEqual(
    store.loadThread("codex-provider:privacyai-startup-preflight").sessionMap,
    {},
    "the synthetic canary must never be persisted as a real session mapping"
  );

  const body = {
    model: "test-model",
    input: capturedPayload,
    stream: false,
    store: false,
    client_metadata: { thread_id: "real-thread" }
  };
  let sanitizerCalls = 0;
  const transformed = await sanitizeCodexRequestBody(body, {
    sanitizer: async () => {
      sanitizerCalls += 1;
      throw new Error("primed rendered startup items must not be classified again");
    },
    sessionMap: {},
    policyFingerprint,
    cache: {
      get(cacheKey, fingerprint) {
        return store.getVerification(cacheKey, fingerprint);
      }
    }
  });

  assert.equal(sanitizerCalls, 0);
  assert.deepEqual(transformed.body.input, capturedPayload);
});

test("Codex prompt renderer terminates its entire probe process group", {
  skip: process.platform === "win32"
}, async () => {
  const root = await createTestTempDir("privacyai-codex-probe-tree-");
  const fakeCodex = join(root, "fake-codex-tree.js");
  const childPidPath = join(root, "child.pid");
  await writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
      "child.unref();",
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      "process.stdout.write(JSON.stringify([{ text: 'rendered' }]));"
    ].join("\n"),
    { mode: 0o755 }
  );
  await chmod(fakeCodex, 0o755);

  assert.deepEqual(
    await captureCodexPromptInput({
      codexPath: fakeCodex,
      args: [],
      cwd: root,
      env: process.env,
      prompt: "ignored",
      timeoutMs: 5000
    }),
    [{ text: "rendered" }]
  );

  const childPid = Number(await readFile(childPidPath, "utf8"));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && processExists(childPid)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(processExists(childPid), false);
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
