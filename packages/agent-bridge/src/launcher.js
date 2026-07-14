import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrivacyConfig } from "./config-store.js";
import { buildCodexProviderArgs, parseCodexPrivacyMode } from "./codex-provider-config.js";
import { startCodexProviderGateway } from "./codex-provider-gateway.js";
import { resolveExecutable } from "./executable.js";
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
import { createPrivacySanitizer } from "./privacy-sanitizer.js";
import { prepareAgentRuntimeIsolation } from "./runtime-isolation.js";
import { auditClaudeStartupContext, auditCodexStartupContext } from "./startup-audit.js";

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

  try {
    const sanitizer = options.sanitizer || createPrivacySanitizer(loaded.config, options);
    let cwd = options.cwd || process.cwd();

    if (flavor === "codex" && codexInvocation.mode === "gateway") {
      cwd = resolve(codexEffectiveCwd(forwardedArgs, cwd));
      gateway = await (options.startCodexProviderGateway || startCodexProviderGateway)({
        sanitizer,
        baseDir: options.vaultDir,
        maxContextChars: options.providerContextMaxChars,
        maxRequestBytes: options.providerMaxRequestBytes,
        maxResponseBytes: options.providerMaxResponseBytes,
        chatgptUpstream: options.chatgptUpstream,
        apiUpstream: options.apiUpstream,
        allowInsecureTestUpstream: options.allowInsecureTestUpstream
      });
      const protectedArgs = buildCodexProviderArgs(gateway.baseURL, options);
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

    if (flavor === "claude") {
      const settingsPath = join(runtimeDir, "claude-settings.json");
      await (options.writeClaudeSettings || writeClaudeSettings)(settingsPath, options);
      await (options.auditClaudeStartupContext || auditClaudeStartupContext)({
        cwd,
        sanitizer,
        maxContextChars: options.startupContextMaxChars,
        maxFiles: options.startupContextMaxFiles
      });
      childArgs = ["--settings", settingsPath, ...isolation.args, ...forwardedArgs];
    } else {
      cwd = resolve(codexEffectiveCwd(forwardedArgs, cwd));
      const declarations = (options.buildCodexHookDeclarationArgs || buildCodexHookDeclarationArgs)(options);
      const trust = await (options.discoverCodexHookTrust || discoverCodexHookTrust)({
        ...options,
        codexPath: binary,
        declarationArgs: [...isolation.args, ...declarations],
        cwd,
        env
      });
      const privacyArgs = [...isolation.args, ...declarations, ...trust.stateArgs];
      await (options.auditCodexStartupContext || auditCodexStartupContext)({
        codexPath: binary,
        args: privacyArgs,
        cwd,
        env,
        sanitizer,
        capture: options.captureCodexPromptInput,
        timeoutMs: options.startupAuditTimeoutMs,
        maxBytes: options.startupAuditMaxBytes,
        maxContextChars: options.startupContextMaxChars
      });
      childArgs = [...privacyArgs, ...forwardedArgs];
    }

    return await (options.spawnInherited || spawnInherited)(
      python,
      [PTY_HELPER, "--runtime-dir", runtimeDir, "--flavor", flavor, "--", binary, ...childArgs],
      { cwd, env }
    );
  } finally {
    await gateway?.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function spawnInherited(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) resolve(128 + signalNumber(signal));
      else resolve(code ?? 1);
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
