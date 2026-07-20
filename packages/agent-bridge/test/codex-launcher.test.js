import { createTestTempDir } from "./test-temp-dir.js";
import assert from "node:assert/strict";
import { access, chmod, rm, writeFile } from "node:fs/promises";
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
  const root = await createTestTempDir("privacyai-launch-gateway-");
  const configPath = await writeTestConfig(root);
  const codexHome = join(root, "normal-codex-home");
  const verificationStore = new MemoryContextVerificationStore();
  const events = [];
  const progress = [];
  let closed = 0;
  let lineageClosed = 0;
  let gatewayOptions;
  let spawned;

  const result = await launchNativeTui("codex", ["exec", "hello"], {
    configPath,
    binary: "/fake/stock-codex",
    cwd: root,
    env: { CODEX_HOME: codexHome },
    launchLockDir: join(root, "locks"),
    healthOptions: { skip: true },
    onLaunchProgress: event => progress.push(event),
    verifyNativeExecutable: async () => ({ version: "test" }),
    sanitizer: passThroughSanitizer,
    openLineageRepository: async () => ({
      async append(event) { return event; },
      close() { lineageClosed += 1; }
    }),
    verificationStore,
    auditCodexStaticStartupContext: async options => {
      events.push("static");
      assert.equal(options.env.CODEX_HOME, codexHome);
      return {
        fileCount: 2,
        serializedBytes: 100,
        sessionMapAdditions: {},
        counters: { sanitizerCalls: 0 }
      };
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
      return {
        itemCount: 4,
        primedItemCount: 3,
        serializedBytes: 200,
        cache: { hit: true }
      };
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
  assert.equal(lineageClosed, 1);
  assert.equal(typeof gatewayOptions.lineageRecorder?.protectedRequest, "function");
  assert.equal(spawned.command, "/fake/stock-codex");
  assert.equal(spawned.options.env.CODEX_HOME, codexHome);
  assert.equal(spawned.args.includes("exec"), true);
  assert.equal(spawned.args.indexOf("exec") > spawned.args.indexOf('model_provider="privacyai"'), true);
  assert.equal(spawned.args.includes("--privacy-gateway"), false);
  assert.equal(gatewayOptions.maxContextChars, 13312);
  assert.equal(gatewayOptions.verificationStore, verificationStore);
  assert.equal(
    progress.some(event => event.message ===
      "Reused cached privacy decisions for 2 local startup file(s)"),
    true
  );
  assert.equal(
    progress.some(event => event.message ===
      "Reused cached Codex startup-prompt verification; skipped prompt rendering"),
    true
  );
  await assert.rejects(access(spawned.options.env.PRIVACYAI_WRAPPER_DIR), /ENOENT/);
});

test("Codex launcher survives classifier false positives on its synthetic startup shield", async t => {
  const root = await createTestTempDir("privacyai-launch-boundary-false-positive-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = await writeTestConfig(root);
  const codexHome = join(root, "empty-codex-home");
  const markerPath = join(root, "launched.txt");
  const fakeCodex = join(root, "fake-codex.mjs");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const debugIndex = args.lastIndexOf('debug');",
    "if (debugIndex >= 0 && args[debugIndex + 1] === 'prompt-input') {",
    "  const prompt = args[debugIndex + 2];",
    "  process.stdout.write(JSON.stringify([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }]));",
    "} else {",
    "  writeFileSync(process.env.PRIVACYAI_FAKE_LAUNCH_MARKER, 'launched');",
    "}"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  let sawBoundaryFalsePositive = false;
  let gatewayClosed = false;
  const result = await launchNativeTui("codex", ["exec", "hello"], {
    configPath,
    binary: fakeCodex,
    cwd: root,
    env: {
      CODEX_HOME: codexHome,
      PRIVACYAI_FAKE_LAUNCH_MARKER: markerPath
    },
    launchLockDir: join(root, "locks"),
    healthOptions: { skip: true },
    policyFingerprint: "sha256:boundary-false-positive-policy",
    verifyNativeExecutable: async () => ({ version: "test" }),
    sanitizer: async text => {
      const token = text.match(/__PRIVACYAI_BOUNDARY_\d+__+/)?.[0];
      if (!token) return { sanitizedPrompt: text, sessionMap: {} };
      sawBoundaryFalsePositive = true;
      return {
        sanitizedPrompt: text.replaceAll(token, "[PRIVATE_VALUE_1]"),
        sessionMap: { "[PRIVATE_VALUE_1]": token }
      };
    },
    verificationStore: new MemoryContextVerificationStore(),
    startCodexProviderGateway: async () => ({
      baseURL: "http://127.0.0.1:17777/test-nonce",
      async close() {
        gatewayClosed = true;
      }
    }),
    enableTuiSessionActions: false,
    showLaunchProgress: false
  });

  assert.equal(result, 0);
  assert.equal(sawBoundaryFalsePositive, true);
  assert.equal(gatewayClosed, true);
  await access(markerPath);
});

test("a warm Codex gateway launch proves the startup fingerprint and skips prompt capture", async () => {
  const root = await createTestTempDir("privacyai-launch-render-cache-");
  const configPath = await writeTestConfig(root);
  const verificationStore = new MemoryContextVerificationStore();
  let captures = 0;
  let gatewayStarts = 0;
  const launch = (overrides = {}) => launchNativeTui("codex", ["exec", "hello"], {
    configPath, binary: process.execPath, cwd: root, env: { CODEX_HOME: join(root, "empty-codex-home") },
    launchLockDir: join(root, "locks"), healthOptions: { skip: true }, policyFingerprint: "sha256:stable-launch-policy",
    verifyNativeExecutable: async () => ({ version: "test" }), sanitizer: passThroughSanitizer, verificationStore,
    captureCodexPromptInput: async ({ prompt }) => { captures += 1; return [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }]; },
    startCodexProviderGateway: async () => {
      gatewayStarts += 1;
      return {
        baseURL: "http://127.0.0.1:" + (17000 + gatewayStarts) + "/nonce-" + gatewayStarts,
        async close() {}
      };
    },
    spawnInherited: async () => 0, showLaunchProgress: false,
    ...overrides
  });
  await launch();
  await launch();
  assert.equal(captures, 1);
  await launch({ requestMaxRetries: 2 });
  assert.equal(captures, 2);
});

test("Codex gateway relaunches protected resume and fork actions requested inside the TUI", async () => {
  const root = await createTestTempDir("privacyai-launch-session-action-");
  const configPath = await writeTestConfig(root);
  const launches = [];
  let closed = 0;

  const result = await launchNativeTui("codex", ["--no-alt-screen", "-C", root], {
    configPath,
    binary: "/fake/stock-codex",
    python: "/fake/python3",
    cwd: root,
    launchLockDir: join(root, "locks"),
    healthOptions: { skip: true },
    verifyNativeExecutable: async () => ({ version: "test" }),
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
    spawnInherited: async (command, args) => {
      launches.push({ command, args });
      assert.equal(command, "/fake/python3");
      assert.equal(args.includes("/fake/stock-codex"), true);
      assert.equal(args.includes('model_provider="privacyai"'), true);

      if (launches.length === 1) {
        const actionFlag = args.indexOf("--session-action-file");
        assert.notEqual(actionFlag, -1);
        await writeFile(
          args[actionFlag + 1],
          JSON.stringify({ version: 1, action: "resume", selector: "--last" }),
          { mode: 0o600 }
        );
        return 86;
      }
      return 0;
    },
    showLaunchProgress: false
  });

  assert.equal(result, 0);
  assert.equal(closed, 1);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].args.includes("resume"), false);
  assert.deepEqual(launches[1].args.slice(-5), [
    "--no-alt-screen",
    "-C",
    root,
    "resume",
    "--last"
  ]);
});

test("Windows keeps interactive Codex on the direct protected gateway launch path", async () => {
  const root = await createTestTempDir("privacyai-launch-windows-gateway-");
  const configPath = await writeTestConfig(root);
  let spawned;
  let closed = 0;

  const result = await launchNativeTui("codex", ["--no-alt-screen"], {
    configPath,
    binary: "C:\\fake\\codex.exe",
    platform: "win32",
    cwd: root,
    launchLockDir: join(root, "locks"),
    healthOptions: { skip: true },
    verifyNativeExecutable: async () => ({ version: "test" }),
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
    spawnInherited: async (command, args) => {
      spawned = { command, args };
      return 0;
    },
    showLaunchProgress: false
  });

  assert.equal(result, 0);
  assert.equal(closed, 1);
  assert.equal(spawned.command, "C:\\fake\\codex.exe");
  assert.equal(spawned.args.includes("--session-action-file"), false);
  assert.equal(spawned.args.includes("--no-alt-screen"), true);
  assert.equal(spawned.args.includes('model_provider="privacyai"'), true);
});

test("Codex gateway closes, releases its lock, and cleans up when spawning fails", async () => {
  const root = await createTestTempDir("privacyai-launch-failure-");
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
    verifyNativeExecutable: async () => ({ version: "test" }),
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

test("Codex cleanup preserves the primary failure while releasing every later resource", async () => {
  const root = await createTestTempDir("privacyai-launch-cleanup-order-");
  const configPath = await writeTestConfig(root);
  let runtimeDir;
  let caught;

  try {
    await launchNativeTui("codex", [], {
      configPath,
      binary: "/fake/stock-codex",
      cwd: root,
      launchLockDir: join(root, "locks"),
      healthOptions: { skip: true },
      verifyNativeExecutable: async () => ({ version: "test" }),
      sanitizer: passThroughSanitizer,
      verificationStore: new MemoryContextVerificationStore(),
      auditCodexStaticStartupContext: async () => ({ fileCount: 0, serializedBytes: 0 }),
      auditCodexStartupContext: async () => ({ itemCount: 1, primedItemCount: 1 }),
      startCodexProviderGateway: async () => ({
        baseURL: "http://127.0.0.1:17777/test-nonce",
        async close() {
          throw new Error("gateway close failed");
        }
      }),
      spawnInherited: async (_command, _args, options) => {
        runtimeDir = options.env.PRIVACYAI_WRAPPER_DIR;
        throw new Error("spawn failed first");
      },
      showLaunchProgress: false
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.message, "spawn failed first");
  assert.equal(caught?.cleanupErrors?.[0]?.name, "gateway");
  assert.equal(caught?.cleanupErrors?.[0]?.error?.message, "gateway close failed");
  await assert.rejects(access(runtimeDir), /ENOENT/);
  const lock = await acquireNativeLaunchLock("codex", root, {
    launchLockDir: join(root, "locks")
  });
  await lock.release();
});

test("Codex cleanup still removes runtime state when cleanup itself is the launch failure", async () => {
  const root = await createTestTempDir("privacyai-launch-cleanup-only-failure-");
  const configPath = await writeTestConfig(root);
  let runtimeDir;

  await assert.rejects(
    launchNativeTui("codex", [], {
      configPath,
      binary: "/fake/stock-codex",
      cwd: root,
      launchLockDir: join(root, "locks"),
      healthOptions: { skip: true },
      verifyNativeExecutable: async () => ({ version: "test" }),
      sanitizer: passThroughSanitizer,
      verificationStore: new MemoryContextVerificationStore(),
      auditCodexStaticStartupContext: async () => ({ fileCount: 0, serializedBytes: 0 }),
      auditCodexStartupContext: async () => ({ itemCount: 1, primedItemCount: 1 }),
      startCodexProviderGateway: async () => ({
        baseURL: "http://127.0.0.1:17777/test-nonce",
        async close() {
          throw new Error("gateway close failed alone");
        }
      }),
      spawnInherited: async (_command, _args, options) => {
        runtimeDir = options.env.PRIVACYAI_WRAPPER_DIR;
        return 0;
      },
      showLaunchProgress: false
    }),
    /gateway close failed alone/
  );

  await assert.rejects(access(runtimeDir), /ENOENT/);
  const lock = await acquireNativeLaunchLock("codex", root, {
    launchLockDir: join(root, "locks")
  });
  await lock.release();
});

test("a broken Codex executable fails before static scanning or gateway startup", async () => {
  const root = await createTestTempDir("privacyai-launch-broken-codex-");
  const configPath = await writeTestConfig(root);
  let staticScanStarted = false;
  let gatewayStarted = false;

  await assert.rejects(
    launchNativeTui("codex", [], {
      configPath,
      binary: "/fake/broken-codex",
      cwd: root,
      healthOptions: { skip: true },
      verifyNativeExecutable: async () => {
        const error = new Error("Codex crashed during startup check.");
        error.code = "PRIVACYAI_CODEX_EXECUTABLE_BROKEN";
        throw error;
      },
      auditCodexStaticStartupContext: async () => {
        staticScanStarted = true;
      },
      startCodexProviderGateway: async () => {
        gatewayStarted = true;
      }
    }),
    error => error?.code === "PRIVACYAI_CODEX_EXECUTABLE_BROKEN"
  );

  assert.equal(staticScanStarted, false);
  assert.equal(gatewayStarted, false);
});

test("a failed static preflight prevents gateway and Codex startup", async () => {
  const root = await createTestTempDir("privacyai-launch-preflight-failure-");
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
    verifyNativeExecutable: async () => ({ version: "test" }),
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
  const root = await createTestTempDir("privacyai-launch-strict-");
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
    verifyNativeExecutable: async () => ({ version: "test" }),
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
  const root = await createTestTempDir("privacyai-launch-lock-");
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
  assert.equal(derivePrivacyMaxTokens({ numCtx: 4096 }), 512);
  assert.equal(derivePrivacyContextMaxChars({ numCtx: 4096 }), 5632);
  assert.equal(derivePrivacyMaxTokens({ numCtx: 2048 }), 512);
  assert.equal(derivePrivacyContextMaxChars({ numCtx: 2048 }), 1536);
  assert.equal(
    derivePrivacyContextMaxChars({ numCtx: 4096 }, { providerContextMaxChars: 7777 }),
    7777
  );
});


test("Codex launch distinguishes a missing configured model from a temporary readiness failure", async () => {
  const root = await createTestTempDir("privacyai-launch-model-health-");
  const configPath = await writeTestConfig(root);

  await assert.rejects(
    launchNativeTui("codex", [], {
      configPath,
      cwd: root,
      healthOptions: {
        fetch: async () => new Response(JSON.stringify({ models: [] }), {
          headers: { "content-type": "application/json" }
        })
      }
    }),
    error => error?.code === "PRIVACYAI_MODEL_UNAVAILABLE" && /privacyai onboard/.test(error.message)
  );

  await assert.rejects(
    launchNativeTui("codex", [], {
      configPath,
      cwd: root,
      healthOptions: {
        fetch: async () => new Response(JSON.stringify({ models: [{ name: "test-model" }] }), {
          headers: { "content-type": "application/json" }
        }),
        readinessAttempts: 1,
        sanitizer: async () => {
          const error = new Error("Provider request failed.");
          error.name = "ProviderError";
          throw error;
        }
      }
    }),
    error =>
      error?.code === "PRIVACYAI_MODEL_NOT_READY" &&
      /finish loading/.test(error.message) &&
      !/privacyai onboard/.test(error.message)
  );
});

test("strict Codex launches always render because no live gateway can verify dynamic startup context", async () => {
  const root = await createTestTempDir("privacyai-launch-strict-render-");
  const configPath = await writeTestConfig(root);
  const verificationStore = new MemoryContextVerificationStore();
  let captures = 0;
  const launch = () => launchNativeTui("codex", ["--privacy-strict"], {
    configPath,
    binary: process.execPath,
    python: process.execPath,
    cwd: root,
    env: { CODEX_HOME: join(root, "empty-codex-home") },
    launchLockDir: join(root, "locks"),
    healthOptions: { skip: true },
    policyFingerprint: "sha256:stable-strict-policy",
    verifyNativeExecutable: async () => ({ version: "test" }),
    sanitizer: passThroughSanitizer,
    verificationStore,
    prepareAgentRuntimeIsolation: async () => ({
      env: { CODEX_HOME: join(root, "isolated-codex-home") },
      args: []
    }),
    buildCodexHookDeclarationArgs: () => [],
    discoverCodexHookTrust: async () => ({ stateArgs: [] }),
    captureCodexPromptInput: async ({ prompt }) => {
      captures += 1;
      return [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }]
      }];
    },
    spawnInherited: async () => 0,
    showLaunchProgress: false
  });

  await launch();
  await launch();
  assert.equal(captures, 2);
});
