import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrivacyConfig } from "./config-store.js";
import { buildCodexProviderArgs, parseCodexPrivacyMode } from "./codex-provider-config.js";
import { startCodexProviderGateway } from "./codex-provider-gateway.js";
import {
  openContextVerificationStore,
  verificationFingerprint
} from "./context-verification-store.js";
import { resolveExecutable } from "./executable.js";
import { acquireNativeLaunchLock } from "./launch-lock.js";
import { checkPrivacyModel } from "./model-health.js";
import {
  validateNativeArguments,
  validateNativeEnvironment
} from "./native-argument-policy.js";
import {
  buildCodexHookDeclarationArgs,
  codexEffectiveCwd,
  discoverCodexHookTrust,
  writeClaudeSettings
} from "./native-hooks.js";
import {
  createPrivacySanitizer,
  derivePrivacyContextMaxChars
} from "./privacy-sanitizer.js";
import { prepareAgentRuntimeIsolation } from "./runtime-isolation.js";
import {
  auditClaudeStartupContext,
  auditCodexStartupContext,
  auditCodexStaticStartupContext
} from "./startup-audit.js";

const PTY_HELPER = fileURLToPath(new URL("../bin/privacyai-pty.py", import.meta.url));

export { validateNativeArguments, validateNativeEnvironment };

export async function launchNativeTui(flavor, userArgs = [], options = {}) {
  if (!new Set(["claude", "codex"]).has(flavor)) {
    throw new TypeError(`Unsupported native agent: ${flavor}`);
  }
  if (process.platform === "win32") {
    throw new Error(
      "This prototype currently supports Linux and macOS. Windows ConPTY support is not implemented yet."
    );
  }

  const codexInvocation = flavor === "codex"
    ? parseCodexPrivacyMode(userArgs, { mode: options.codexMode })
    : { mode: null, args: userArgs };
  const forwardedArgs = codexInvocation.args;
  validateNativeArguments(flavor, forwardedArgs, { codexMode: codexInvocation.mode });

  const loaded = await loadPrivacyConfig({ path: options.configPath });
  if (!loaded.configured) throw onboardingRequiredError();

  const health = await checkPrivacyModel(loaded.config, options.healthOptions);
  if (!health.ok) {
    const error = onboardingRequiredError();
    error.message = `${health.reason}\nRun: privacyai onboard`;
    throw error;
  }

  const binary = options.binary || (await resolveExecutable(flavor));
  if (!binary) throw new Error(`${flavor} is not installed or is not available on PATH.`);

  let cwd = options.cwd || process.cwd();
  if (flavor === "codex") cwd = resolve(codexEffectiveCwd(forwardedArgs, cwd));

  const runtimeDir = await mkdtemp(join(tmpdir(), "privacyai-agent-"));
  await chmod(runtimeDir, 0o700);
  const env = {
    ...process.env,
    ...options.env,
    PRIVACYAI_CONFIG_FILE: loaded.path,
    PRIVACYAI_WRAPPER_DIR: runtimeDir,
    PRIVACYAI_AGENT_FLAVOR: flavor
  };
  let gateway;
  let verificationStore;
  let ownsVerificationStore = false;
  let launchLock;

  try {
    if (flavor === "codex") {
      launchLock = await (options.acquireNativeLaunchLock || acquireNativeLaunchLock)(
        flavor,
        cwd,
        options
      );
    }

    const sanitizer = options.sanitizer || createPrivacySanitizer(loaded.config, options);
    const providerContextMaxChars = derivePrivacyContextMaxChars(loaded.config, options);

    if (flavor === "codex" && codexInvocation.mode === "gateway") {
      verificationStore = await openContextVerificationStore(options);
      ownsVerificationStore = !options.verificationStore;
      const policyFingerprint = launchPolicyFingerprint(sanitizer, options, "codex-provider");

      await reportLaunchProgress(options, "static-scan", "Sanitizing local Codex startup files before launch");
      const staticAudit = await (options.auditCodexStaticStartupContext || auditCodexStaticStartupContext)({
        cwd,
        env,
        sanitizer,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        maxBytes: options.startupStaticMaxBytes,
        maxFiles: options.startupContextMaxFiles,
        verificationStore,
        policyFingerprint,
        // Gateway mode sanitizes the rendered request before it can leave the
        // machine, so discoveries are cached rather than treated as fatal.
        blockHighRisk: false
      });
      await reportLaunchProgress(
        options,
        "static-scan-complete",
        `Sanitized ${staticAudit.fileCount} local startup file(s)`
      );

      await reportLaunchProgress(options, "gateway", "Starting the protected localhost gateway");
      gateway = await (options.startCodexProviderGateway || startCodexProviderGateway)({
        sanitizer,
        verificationStore,
        baseDir: options.vaultDir,
        maxContextChars: providerContextMaxChars,
        maxRequestBytes: options.providerMaxRequestBytes,
        maxResponseBytes: options.providerMaxResponseBytes,
        maxVerifiedItems: options.maxVerifiedItems,
        maxThreadItems: options.maxThreadItems,
        verificationMaxAgeMs: options.verificationMaxAgeMs,
        policyFingerprint,
        onGatewayError: options.onGatewayError,
        onSanitizedRequest: options.onSanitizedRequest,
        chatgptUpstream: options.chatgptUpstream,
        apiUpstream: options.apiUpstream,
        allowInsecureTestUpstream: options.allowInsecureTestUpstream
      });
      const protectedArgs = buildCodexProviderArgs(gateway.baseURL, options);

      await reportLaunchProgress(options, "prompt-render", "Rendering the exact Codex startup prompt");
      const renderedAudit = await (options.auditCodexStartupContext || auditCodexStartupContext)({
        codexPath: binary,
        args: protectedArgs,
        cwd,
        env,
        sanitizer,
        capture: options.captureCodexPromptInput,
        timeoutMs: options.startupAuditTimeoutMs,
        maxBytes: options.startupAuditMaxBytes,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        verificationStore,
        policyFingerprint,
        blockHighRisk: false,
        primeRequestCache: true
      });
      await reportLaunchProgress(
        options,
        "prompt-verified",
        `Verified and cached ${renderedAudit.primedItemCount} rendered startup item(s)`
      );
      await reportLaunchProgress(options, "launch", "Startup context is safe; launching Codex");

      return await (options.spawnInherited || spawnInherited)(
        binary,
        [...protectedArgs, ...forwardedArgs],
        { cwd, env }
      );
    }

    const python =
      options.python ||
      (await resolveExecutable("python3")) ||
      (await resolveExecutable("python"));
    if (!python) throw new Error("PrivacyAI requires Python 3 for its transparent Unix PTY wrapper.");

    const isolation = await (options.prepareAgentRuntimeIsolation || prepareAgentRuntimeIsolation)(
      flavor,
      runtimeDir,
      { ...options, env }
    );
    Object.assign(env, isolation.env);
    validateNativeEnvironment(flavor, env);
    let childArgs;

    verificationStore = await openContextVerificationStore(options);
    ownsVerificationStore = !options.verificationStore;
    const policyFingerprint = launchPolicyFingerprint(sanitizer, options, "startup-context");

    if (flavor === "claude") {
      const settingsPath = join(runtimeDir, "claude-settings.json");
      await (options.writeClaudeSettings || writeClaudeSettings)(settingsPath, options);
      await (options.auditClaudeStartupContext || auditClaudeStartupContext)({
        cwd,
        sanitizer,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        maxFiles: options.startupContextMaxFiles,
        verificationStore,
        policyFingerprint
      });
      childArgs = ["--settings", settingsPath, ...isolation.args, ...forwardedArgs];
    } else {
      await reportLaunchProgress(options, "static-scan", "Sanitizing local Codex startup files before launch");
      await (options.auditCodexStaticStartupContext || auditCodexStaticStartupContext)({
        cwd,
        env,
        sanitizer,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        maxBytes: options.startupStaticMaxBytes,
        maxFiles: options.startupContextMaxFiles,
        verificationStore,
        policyFingerprint,
        blockHighRisk: true
      });

      const declarations = (options.buildCodexHookDeclarationArgs || buildCodexHookDeclarationArgs)(options);
      const trust = await (options.discoverCodexHookTrust || discoverCodexHookTrust)({
        ...options,
        codexPath: binary,
        declarationArgs: [...isolation.args, ...declarations],
        cwd,
        env
      });
      const privacyArgs = [...isolation.args, ...declarations, ...trust.stateArgs];
      await reportLaunchProgress(options, "prompt-render", "Rendering and verifying the exact Codex startup prompt");
      await (options.auditCodexStartupContext || auditCodexStartupContext)({
        codexPath: binary,
        args: privacyArgs,
        cwd,
        env,
        sanitizer,
        capture: options.captureCodexPromptInput,
        timeoutMs: options.startupAuditTimeoutMs,
        maxBytes: options.startupAuditMaxBytes,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        verificationStore,
        policyFingerprint,
        blockHighRisk: true
      });
      childArgs = [...privacyArgs, ...forwardedArgs];
    }

    await reportLaunchProgress(options, "launch", `Startup context is safe; launching ${flavor}`);
    return await (options.spawnInherited || spawnInherited)(
      python,
      [PTY_HELPER, "--runtime-dir", runtimeDir, "--flavor", flavor, "--", binary, ...childArgs],
      { cwd, env }
    );
  } finally {
    await gateway?.close();
    if (ownsVerificationStore) verificationStore?.close();
    await launchLock?.release();
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function launchPolicyFingerprint(sanitizer, options, boundary) {
  const stable = options.policyFingerprint || sanitizer.identity?.fingerprint;
  if (stable) return String(stable);
  return verificationFingerprint({
    boundary,
    version: 4,
    // A custom closure has no trustworthy persistent identity. Keep all
    // preflight and gateway caches consistent inside this launch, but force a
    // miss on the next launch unless the caller supplies policyFingerprint.
    ephemeralSanitizerNonce: randomBytes(32).toString("hex")
  });
}

async function reportLaunchProgress(options, stage, message) {
  if (typeof options.onLaunchProgress === "function") {
    await options.onLaunchProgress({ stage, message });
  }
  if (options.showLaunchProgress === false || !process.stderr.isTTY) return;
  process.stderr.write(`[PrivacyAI] ${message}\n`);
}

function spawnInherited(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) resolvePromise(128 + signalNumber(signal));
      else resolvePromise(code ?? 1);
    });
  });
}

function onboardingRequiredError() {
  const error = new Error("PrivacyAI is not configured.\nRun: privacyai onboard");
  error.code = "PRIVACYAI_ONBOARDING_REQUIRED";
  return error;
}

function signalNumber(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };
  return numbers[signal] || 1;
}
