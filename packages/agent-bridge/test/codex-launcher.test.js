import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MemoryContextVerificationStore,
  acquireNativeLaunchLock,
  derivePrivacyContextMaxChars,
  derivePrivacyMaxTokens,
  launchNativeTui,
  savePrivacyConfig
} from "../src/index.js";

async function writeTestConfig(root) {
  const configPath = join(root, "config.json");
  await savePrivacyConfig({
    provider: "ollama",
    model: "test-model",
    baseURL: "http://127.0.0.1:11434"
  }, { path: configPath });
  return configPath;
}

function passThroughSanitizer(text) {
  return { sanitizedPrompt: text, sessionMap: {} };
}

test("Codex gateway preflights static and rendered context before spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-gateway-"));
  const configPath = await writeTestConfig(root);
  const codexHome = join(root, "normal-codex-home");
  const verificationStore = new MemoryContextVerificationStore();
  const events = [];
  let closed = 0;
  let gatewayOptions;
  let spawned;

  const result = await launchNativeTui("codex", ["exec", "hello"], {
    configPath,
    binary: "/fake/stock-codex",
    cwd: root,
    env: { CODEX_HOME: codexHome },
    launchLockDir: join(root, "locks"),
    healthOptions: { skip: true },
    sanitizer: passThroughSanitizer,
    verificationStore,
    auditCodexStaticStartupContext: async options => {
      events.push("static");
      assert.equal(options.env.CODEX_HOME, codexHome);
      return { fileCount: 2, serializedBytes: 100, sessionMapAdditions: {} };
    },
    startCodexProviderGateway: async options => {
      events.push("gateway");
      gatewayOptions = options;
      return {
        baseURL: "http://127.0.0.1:17777/test-nonce",
        async close() {
          closed += 1;
        }
      };
    },
    auditCodexStartupContext: async options => {
      events.push("render");
      assert.equal(options.primeRequestCache, true);
      assert.equal(options.verificationStore, verificationStore);
      return { itemCount: 4, primedItemCount: 3, serializedBytes: 200 };
    },
    spawnInherited: async (command, args, options) => {
      events.push("spawn");
      spawned = { command, args, options };
      return 0;
    }
  });

  assert.equal(result, 0);
  assert.deepEqual(events, ["static", "gateway", "render", "spawn"]);
  assert.equal(closed, 1);
  assert.equal(spawned.command, "/fake/stock-codex");
  assert.equal(spawned.options.env.CODEX_HOME, codexHome);
  assert.equal(spawned.args.includes("exec"), true);
  assert.equal(spawned.args.indexOf("exec") > spawned.args.indexOf('model_provider="privacyai"'), true);
  assert.equal(spawned.args.includes("--privacy-gateway"), false);
  assert.equal(gatewayOptions.maxContextChars, 5120);
  assert.equal(gatewayOptions.verificationStore, verificationStore);
  await assert.rejects(access(spawned.options.env.PRIVACYAI_WRAPPER_DIR), /ENOENT/);
});

test("Codex gateway closes, releases its lock, and cleans up when spawning fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-failure-"));
  const configPath = await writeTestConfig(root);
  let closed = 0;
  let runtimeDir;

  await assert.rejects(
    launchNativeTui("codex", [], {
      configPath,
      binary: "/fake/stock-codex",
      cwd: root,
      launchLockDir: join(root, "locks"),
      healthOptions: { skip: true },
      sanitizer: passThroughSanitizer,
      verificationStore: new MemoryContextVerificationStore(),
      auditCodexStaticStartupContext: async () => ({ fileCount: 0, serializedBytes: 0 }),
      auditCodexStartupContext: async () => ({ itemCount: 1, primedItemCount: 1 }),
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
  const lock = await acquireNativeLaunchLock("codex", root, {
    launchLockDir: join(root, "locks")
  });
  await lock.release();
});

test("a failed static preflight prevents gateway and Codex startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-preflight-failure-"));
  const configPath = await writeTestConfig(root);
  let gatewayStarted = false;
  let rendererStarted = false;
  let childStarted = false;

  await assert.rejects(
    launchNativeTui("codex", [], {
      configPath,
      binary: "/fake/stock-codex",
      cwd: root,
      launchLockDir: join(root, "locks"),
      healthOptions: { skip: true },
      sanitizer: passThroughSanitizer,
      verificationStore: new MemoryContextVerificationStore(),
      auditCodexStaticStartupContext: async () => {
        const error = new Error("unsafe static startup context");
        error.code = "PRIVACYAI_UNSAFE_STARTUP_CONTEXT";
        throw error;
      },
      startCodexProviderGateway: async () => {
        gatewayStarted = true;
        throw new Error("must not start gateway");
      },
      auditCodexStartupContext: async () => {
        rendererStarted = true;
      },
      spawnInherited: async () => {
        childStarted = true;
      }
    }),
    error => error?.code === "PRIVACYAI_UNSAFE_STARTUP_CONTEXT"
  );

  assert.equal(gatewayStarted, false);
  assert.equal(rendererStarted, false);
  assert.equal(childStarted, false);
});

test("explicit strict mode preflights before trust discovery and never starts a gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-strict-"));
  const configPath = await writeTestConfig(root);
  const events = [];
  let gatewayStarted = false;
  let verificationStoreClosed = 0;
  let spawned;

  const result = await launchNativeTui("codex", ["--privacy-strict"], {
    configPath,
    binary: "/fake/stock-codex",
    cwd: root,
    python: "/fake/python3",
    launchLockDir: join(root, "locks"),
    healthOptions: { skip: true },
    sanitizer: passThroughSanitizer,
    verificationStore: {
      close() { verificationStoreClosed += 1; }
    },
    startCodexProviderGateway: async () => {
      gatewayStarted = true;
      throw new Error("strict mode must not start gateway");
    },
    prepareAgentRuntimeIsolation: async () => ({
      env: { CODEX_HOME: "/isolated" },
      args: ["--disable", "apps"]
    }),
    auditCodexStaticStartupContext: async options => {
      events.push("static");
      assert.equal(options.env.CODEX_HOME, "/isolated");
      return { fileCount: 0, serializedBytes: 0 };
    },
    buildCodexHookDeclarationArgs: () => ["--enable", "hooks"],
    discoverCodexHookTrust: async () => {
      events.push("trust");
      return { stateArgs: ["-c", "hooks.trusted=true"] };
    },
    auditCodexStartupContext: async () => {
      events.push("render");
    },
    spawnInherited: async (command, args, options) => {
      events.push("spawn");
      spawned = { command, args, options };
      return 0;
    }
  });

  assert.equal(result, 0);
  assert.deepEqual(events, ["static", "trust", "render", "spawn"]);
  assert.equal(gatewayStarted, false);
  assert.equal(verificationStoreClosed, 0);
  assert.equal(spawned.command, "/fake/python3");
  assert.equal(spawned.args.includes("--privacy-strict"), false);
  assert.equal(spawned.args.includes("/fake/stock-codex"), true);
  assert.equal(spawned.options.env.CODEX_HOME, "/isolated");
});

test("native launch lock rejects a duplicate live wrapper and recovers after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-launch-lock-"));
  const options = { launchLockDir: join(root, "locks") };
  const first = await acquireNativeLaunchLock("codex", root, options);

  await assert.rejects(
    acquireNativeLaunchLock("codex", root, options),
    error => error?.code === "PRIVACYAI_AGENT_ALREADY_RUNNING" && error.ownerPid === process.pid
  );

  await first.release();
  const second = await acquireNativeLaunchLock("codex", root, options);
  await second.release();

  await assert.rejects(
    acquireNativeLaunchLock("codex", root, {
      ...options,
      findActiveNativeLaunch: async () => ({ pid: 4321 })
    }),
    error => error?.code === "PRIVACYAI_AGENT_ALREADY_RUNNING" && error.ownerPid === 4321
  );
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
