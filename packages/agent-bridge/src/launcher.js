import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrivacyConfig } from "./config-store.js";
import { buildCodexProviderArgs, parseCodexPrivacyMode } from "./codex-provider-config.js";
import { startCodexProviderGateway } from "./codex-provider-gateway.js";
import {
  CODEX_TUI_SESSION_ACTION_EXIT_CODE,
  buildCodexTuiSessionActionArgs,
  parseCodexTuiSessionActionRecord,
  supportsCodexTuiSessionActions
} from "./codex-tui-session-action.js";
import {
  openContextVerificationStore,
  verificationFingerprint
} from "./context-verification-store.js";
import { resolveExecutable, verifyNativeExecutable } from "./executable.js";
import { acquireNativeLaunchLock } from "./launch-lock.js";
import { checkPrivacyModel, privacyModelHealthError } from "./model-health.js";
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
  derivePrivacyContextMaxChars,
  derivePrivacyContextMaxTokens
} from "./privacy-sanitizer.js";
import { runInheritedProcess } from "./process-supervisor.js";
import { runCleanupSteps } from "./resource-cleanup.js";
import { prepareAgentRuntimeIsolation } from "./runtime-isolation.js";
import {
  auditClaudeStartupContext,
  auditCodexStartupContext,
  auditCodexStaticStartupContext
} from "./startup-audit.js";
import { renderedStartupFingerprint } from "./startup-cache.js";
import { createLineageRecorder, openLineageRepository } from "./lineage/index.js";

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

  const health = await checkPrivacyModel(loaded.config, {
    probeCompletion: true,
    ...options.healthOptions
  });
  if (!health.ok) throw privacyModelHealthError(health);

  const binary = options.binary || (await resolveExecutable(flavor));
  if (!binary) {
    if (flavor === "codex") {
      throw new Error(
        "Codex is not installed, is not available on PATH, or its platform package is incomplete. " +
        "Reinstall it with: npm install -g @openai/codex@latest"
      );
    }
    throw new Error(`${flavor} is not installed or is not available on PATH.`);
  }

  let cwd = options.cwd || process.cwd();
  if (flavor === "codex") cwd = resolve(codexEffectiveCwd(forwardedArgs, cwd));
  const executableProbe = await (options.verifyNativeExecutable || verifyNativeExecutable)(flavor, binary, {
    cwd,
    env: { ...process.env, ...options.env },
    timeoutMs: options.executableProbeTimeoutMs,
    maxBytes: options.executableProbeMaxBytes
  });

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
  let primaryError;
  let lineageRepository;
  let ownsLineageRepository = false;

  try {
    // The native Codex launch lock protects every Codex invocation.  Lineage
    // is provider-gateway traffic only, but must not narrow that lock scope.
    if (flavor === "codex") {
      launchLock = await (options.acquireNativeLaunchLock || acquireNativeLaunchLock)(
        flavor,
        cwd,
        options
      );
    }
    if (flavor === "codex" && codexInvocation.mode === "gateway") {
      if (!options.lineageRecorder) {
        lineageRepository = await (options.openLineageRepository || openLineageRepository)({
          lineageRepository: options.lineageRepository,
          lineageDbPath: options.lineageDbPath,
          lineageBusyTimeoutMs: options.lineageBusyTimeoutMs,
          lineageRetryTimeoutMs: options.lineageRetryTimeoutMs
        });
        ownsLineageRepository = !options.lineageRepository;
      }
    }

    const sanitizer = options.sanitizer || createPrivacySanitizer(loaded.config, options);
    const providerContextMaxChars = derivePrivacyContextMaxChars(loaded.config, options);
    const providerContextMaxTokens = derivePrivacyContextMaxTokens(loaded.config, options);

    if (flavor === "codex" && codexInvocation.mode === "gateway") {
      verificationStore = await openContextVerificationStore(options);
      ownsVerificationStore = !options.verificationStore;
      const policyFingerprint = launchPolicyFingerprint(sanitizer, options, "codex-provider");
      env.PRIVACYAI_POLICY_FINGERPRINT = policyFingerprint;
      env.PRIVACYAI_TOOL_POLICY = "gateway";

      await reportLaunchProgress(options, "static-scan", "Checking local Codex startup-file cache");
      const staticAudit = await (options.auditCodexStaticStartupContext || auditCodexStaticStartupContext)({
        cwd,
        env,
        sanitizer,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        maxContextTokens: options.startupContextMaxTokens ?? providerContextMaxTokens,
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
        codexStaticAuditProgressMessage(staticAudit)
      );

      await reportLaunchProgress(options, "gateway", "Starting the protected localhost gateway");
      gateway = await (options.startCodexProviderGateway || startCodexProviderGateway)({
        sanitizer,
        verificationStore,
        cwd,
        baseDir: options.vaultDir,
        maxContextChars: providerContextMaxChars,
        maxContextTokens: providerContextMaxTokens,
        maxRequestBytes: options.providerMaxRequestBytes,
        maxResponseBytes: options.providerMaxResponseBytes,
        maxVerifiedItems: options.maxVerifiedItems,
        maxThreadItems: options.maxThreadItems,
        verificationMaxAgeMs: options.verificationMaxAgeMs,
        policyFingerprint,
        onGatewayError: options.onGatewayError,
        onSanitizedRequest: options.onSanitizedRequest,
        onSanitizerBatchComplete: options.onSanitizerBatchComplete,
        onSanitizerArtifactComplete: options.onSanitizerArtifactComplete,
        chatgptUpstream: options.chatgptUpstream,
        apiUpstream: options.apiUpstream,
        allowInsecureTestUpstream: options.allowInsecureTestUpstream,
        upstreamTimeoutMs: options.upstreamTimeoutMs,
        upstreamIdleTimeoutMs: options.upstreamIdleTimeoutMs,
        lineageRecorder: options.lineageRecorder || createLineageRecorder(lineageRepository)
      });
      const protectedArgs = buildCodexProviderArgs(gateway.baseURL, options);

      await reportLaunchProgress(options, "prompt-render", "Checking exact Codex startup-prompt cache");
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
        maxContextTokens: options.startupContextMaxTokens ?? providerContextMaxTokens,
        verificationStore,
        policyFingerprint,
        renderedFingerprint: await startupRenderFingerprint({ binary, executableProbe, cwd, staticAudit, policyFingerprint, args: protectedArgs, config: loaded.config }),
        blockHighRisk: false,
        primeRequestCache: true
      });
      await reportLaunchProgress(
        options,
        "prompt-verified",
        codexRenderedAuditProgressMessage(renderedAudit)
      );
      await reportLaunchProgress(options, "launch", "Startup context is safe; launching Codex");

      return await launchCodexGatewayTui({
        binary,
        protectedArgs,
        forwardedArgs,
        runtimeDir,
        cwd,
        env,
        options
      });
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
    env.PRIVACYAI_POLICY_FINGERPRINT = policyFingerprint;
    env.PRIVACYAI_TOOL_POLICY = flavor === "claude" ? "gateway" : "isolate";

    if (flavor === "claude") {
      const settingsPath = join(runtimeDir, "claude-settings.json");
      await (options.writeClaudeSettings || writeClaudeSettings)(settingsPath, options);
      await (options.auditClaudeStartupContext || auditClaudeStartupContext)({
        cwd,
        sanitizer,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        maxContextTokens: options.startupContextMaxTokens ?? providerContextMaxTokens,
        maxFiles: options.startupContextMaxFiles,
        verificationStore,
        policyFingerprint
      });
      childArgs = ["--settings", settingsPath, ...isolation.args, ...forwardedArgs];
    } else {
      await reportLaunchProgress(options, "static-scan", "Sanitizing local Codex startup files before launch");
      const staticAudit = await (options.auditCodexStaticStartupContext || auditCodexStaticStartupContext)({
        cwd,
        env,
        sanitizer,
        maxContextChars: options.startupContextMaxChars ?? providerContextMaxChars,
        maxContextTokens: options.startupContextMaxTokens ?? providerContextMaxTokens,
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
        maxContextTokens: options.startupContextMaxTokens ?? providerContextMaxTokens,
        verificationStore,
        policyFingerprint,
        // Strict mode has no live provider gateway to re-verify dynamic MCP
        // startup context, so it must render and inspect on every launch.
        blockHighRisk: true
      });
      childArgs = [...privacyArgs, ...forwardedArgs];
    }

    await reportLaunchProgress(options, "launch", `Startup context is safe; launching ${flavor}`);
    return await (options.spawnInherited || runInheritedProcess)(
      python,
      [PTY_HELPER, "--runtime-dir", runtimeDir, "--flavor", flavor, "--", binary, ...childArgs],
      { cwd, env }
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await runCleanupSteps([
      { name: "gateway", run: () => gateway?.close() },
      { name: "lineage", run: () => ownsLineageRepository ? lineageRepository?.close() : undefined },
      {
        name: "verification-store",
        run: () => ownsVerificationStore ? Promise.resolve(verificationStore?.close()) : undefined
      },
      { name: "launch-lock", run: () => launchLock?.release() },
      { name: "runtime-directory", run: () => rm(runtimeDir, { recursive: true, force: true }) }
    ], {
      primaryError,
      message: "PrivacyAI could not fully clean up the native agent runtime."
    });
  }
}

async function launchCodexGatewayTui({
  binary,
  protectedArgs,
  forwardedArgs,
  runtimeDir,
  cwd,
  env,
  options
}) {
  const spawnProcess = options.spawnInherited || runInheritedProcess;
  const platform = options.platform || process.platform;
  if (
    platform === "win32" ||
    options.enableTuiSessionActions === false ||
    !supportsCodexTuiSessionActions(forwardedArgs)
  ) {
    return spawnProcess(binary, [...protectedArgs, ...forwardedArgs], { cwd, env });
  }

  const python =
    options.python ||
    (await resolveExecutable("python3")) ||
    (await resolveExecutable("python"));
  if (!python) {
    throw new Error(
      "PrivacyAI requires Python 3 for protected /resume and /fork handling inside the Codex TUI."
    );
  }

  const actionPath = join(runtimeDir, "codex-tui-session-action.json");
  let currentArgs = forwardedArgs;

  while (true) {
    await rm(actionPath, { force: true });
    const code = await spawnProcess(
      python,
      [
        PTY_HELPER,
        "--runtime-dir",
        runtimeDir,
        "--flavor",
        "codex",
        "--session-action-file",
        actionPath,
        "--",
        binary,
        ...protectedArgs,
        ...currentArgs
      ],
      { cwd, env }
    );

    if (code !== CODEX_TUI_SESSION_ACTION_EXIT_CODE) return code;

    const action = await readCodexTuiSessionAction(actionPath);
    currentArgs = buildCodexTuiSessionActionArgs(forwardedArgs, action);
    const target = action.selector ? `${action.action} ${action.selector}` : `${action.action} picker`;
    await reportLaunchProgress(
      options,
      "session-action",
      `Launching protected Codex ${target}`
    );
  }
}

async function readCodexTuiSessionAction(path) {
  let record;
  try {
    record = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("PrivacyAI rejected a missing or malformed Codex TUI session action.");
  }

  const action = parseCodexTuiSessionActionRecord(record);
  if (!action) {
    throw new Error("PrivacyAI rejected an invalid Codex TUI session action.");
  }
  return action;
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

function stableProtectedArgsForFingerprint(args) {
  return (args || []).map(value => {
    const argument = String(value);
    if (!argument.startsWith("model_providers.privacyai=")) return argument;
    return argument.replace(
      /base_url="http:\/\/127\.0\.0\.1:\d+(?:\/[^\"]*)?"/,
      'base_url="<privacyai-loopback>"'
    );
  });
}

async function startupRenderFingerprint({ binary, executableProbe, cwd, staticAudit, policyFingerprint, args, config }) {
  let stat = null;
  try {
    const value = await lstat(binary, { bigint: true });
    stat = { size: Number(value.size), mtimeNs: value.mtimeNs.toString(), ctimeNs: value.ctimeNs.toString(), dev: value.dev.toString(), ino: value.ino.toString(), mode: Number(value.mode) };
  } catch {
    // Test doubles and PATH-resolved commands can lack a filesystem entry;
    // their resolved identity/version remains part of the proof key.
  }
  return renderedStartupFingerprint({
    manifestHash: staticAudit?.manifestHash || "no-manifest",
    policyFingerprint,
    protectedArgs: stableProtectedArgsForFingerprint(args),
    config,
    cwd,
    repositoryId: staticAudit?.repositoryId || "unknown-repository",
    worktreeId: staticAudit?.worktreeId || "unknown-worktree",
    executable: { path: binary, stat, version: executableProbe?.version || executableProbe || null },
    renderContractVersion: 1
  });
}

function codexStaticAuditProgressMessage(audit) {
  const fileCount = Number(audit?.fileCount || 0);
  const sanitizerCalls = Number(audit?.counters?.sanitizerCalls);
  if (Number.isFinite(sanitizerCalls)) {
    if (sanitizerCalls === 0) {
      return `Reused cached privacy decisions for ${fileCount} local startup file(s)`;
    }
    const reused = Math.max(0, fileCount - sanitizerCalls);
    if (reused > 0) {
      return `Sanitized ${sanitizerCalls} changed startup file(s); reused ${reused} cached file(s)`;
    }
    return `Sanitized ${sanitizerCalls} local startup file(s)`;
  }
  return `Verified ${fileCount} local startup file(s)`;
}

function codexRenderedAuditProgressMessage(audit) {
  if (audit?.cache?.hit === true) {
    return "Reused cached Codex startup-prompt verification; skipped prompt rendering";
  }
  return `Rendered, verified, and cached ${Number(audit?.primedItemCount || 0)} startup item(s)`;
}

async function reportLaunchProgress(options, stage, message) {
  if (typeof options.onLaunchProgress === "function") {
    await options.onLaunchProgress({ stage, message });
  }
  if (options.showLaunchProgress === false || !process.stderr.isTTY) return;
  process.stderr.write(`[PrivacyAI] ${message}\n`);
}

function onboardingRequiredError() {
  const error = new Error("PrivacyAI is not configured.\nRun: privacyai onboard");
  error.code = "PRIVACYAI_ONBOARDING_REQUIRED";
  return error;
}
