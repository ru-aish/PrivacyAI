import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  derivePrivacyContextMaxChars,
  derivePrivacyMaxTokens,
  launchNativeTui,
  savePrivacyConfig
} from "../src/index.js";

test("Codex gateway launcher preserves normal CODEX_HOME and closes the gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-gateway-"));
  const configPath = join(root, "config.json");
  const codexHome = join(root, "normal-codex-home");
  await savePrivacyConfig({
    provider: "ollama",
    model: "test-model",
    baseURL: "http://127.0.0.1:11434"
  }, { path: configPath });

  let closed = 0;
  let gatewayOptions;
  let spawned;
  const result = await launchNativeTui("codex", ["exec", "hello"], {
    configPath,
    binary: "/fake/stock-codex",
    env: { CODEX_HOME: codexHome },
    healthOptions: { skip: true },
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    startCodexProviderGateway: async options => {
      gatewayOptions = options;
      return {
      baseURL: "http://127.0.0.1:17777/test-nonce",
      async close() {
        closed += 1;
      }
    };
    },
    spawnInherited: async (command, args, options) => {
      spawned = { command, args, options };
      return 0;
    }
  });

  assert.equal(result, 0);
  assert.equal(closed, 1);
  assert.equal(spawned.command, "/fake/stock-codex");
  assert.equal(spawned.options.env.CODEX_HOME, codexHome);
  assert.equal(spawned.args.includes("exec"), true);
  assert.equal(spawned.args.indexOf("exec") > spawned.args.indexOf('model_provider="privacyai"'), true);
  assert.equal(spawned.args.includes("--privacy-gateway"), false);
  assert.equal(gatewayOptions.maxContextChars, 5120);
  await assert.rejects(access(spawned.options.env.PRIVACYAI_WRAPPER_DIR), /ENOENT/);
});

test("Codex gateway launcher closes and cleans up when spawning fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-failure-"));
  const configPath = join(root, "config.json");
  await savePrivacyConfig({
    provider: "ollama",
    model: "test-model",
    baseURL: "http://127.0.0.1:11434"
  }, { path: configPath });

  let closed = 0;
  let runtimeDir;
  await assert.rejects(
    launchNativeTui("codex", [], {
      configPath,
      binary: "/fake/stock-codex",
      healthOptions: { skip: true },
      sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
      startCodexProviderGateway: async () => ({
        baseURL: "http://127.0.0.1:17777/test-nonce",
        async close() {
          closed += 1;
        }
      }),
      spawnInherited: async (_command, _args, options) => {
        runtimeDir = options.env.PRIVACYAI_WRAPPER_DIR;
        throw new Error("spawn failed");
      }
    }),
    /spawn failed/
  );
  assert.equal(closed, 1);
  await assert.rejects(access(runtimeDir), /ENOENT/);
});

test("explicit strict mode retains the isolated hook path and never starts a gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-strict-"));
  const configPath = join(root, "config.json");
  await savePrivacyConfig({
    provider: "ollama",
    model: "test-model",
    baseURL: "http://127.0.0.1:11434"
  }, { path: configPath });

  let gatewayStarted = false;
  let verificationStoreClosed = 0;
  let spawned;
  const result = await launchNativeTui("codex", ["--privacy-strict"], {
    configPath,
    binary: "/fake/stock-codex",
    python: "/fake/python3",
    healthOptions: { skip: true },
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    verificationStore: {
      close() { verificationStoreClosed += 1; }
    },
    startCodexProviderGateway: async () => {
      gatewayStarted = true;
      throw new Error("strict mode must not start gateway");
    },
    prepareAgentRuntimeIsolation: async () => ({ env: { CODEX_HOME: "/isolated" }, args: ["--disable", "apps"] }),
    buildCodexHookDeclarationArgs: () => ["--enable", "hooks"],
    discoverCodexHookTrust: async () => ({ stateArgs: ["-c", "hooks.trusted=true"] }),
    auditCodexStartupContext: async () => {},
    spawnInherited: async (command, args, options) => {
      spawned = { command, args, options };
      return 0;
    }
  });

  assert.equal(result, 0);
  assert.equal(gatewayStarted, false);
  assert.equal(verificationStoreClosed, 0);
  assert.equal(spawned.command, "/fake/python3");
  assert.equal(spawned.args.includes("--privacy-strict"), false);
  assert.equal(spawned.args.includes("/fake/stock-codex"), true);
  assert.equal(spawned.options.env.CODEX_HOME, "/isolated");
});


test("local-model budgets derive bounded chunk and output sizes from numCtx", () => {
  assert.equal(derivePrivacyMaxTokens({ numCtx: 4096 }), 1024);
  assert.equal(derivePrivacyContextMaxChars({ numCtx: 4096 }), 5120);
  assert.equal(derivePrivacyMaxTokens({ numCtx: 2048 }), 512);
  assert.equal(derivePrivacyContextMaxChars({ numCtx: 2048 }), 2048);
  assert.equal(
    derivePrivacyContextMaxChars({ numCtx: 4096 }, { providerContextMaxChars: 7777 }),
    7777
  );
});
