import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrivacyConfig } from "./config-store.js";
import { resolveExecutable } from "./executable.js";
import { checkPrivacyModel } from "./model-health.js";
import { createPrivacySanitizer } from "./privacy-sanitizer.js";
import {
  buildCodexHookDeclarationArgs,
  codexEffectiveCwd,
  discoverCodexHookTrust,
  writeClaudeSettings
} from "./native-hooks.js";
import { prepareAgentRuntimeIsolation } from "./runtime-isolation.js";
import { auditClaudeStartupContext, auditCodexStartupContext } from "./startup-audit.js";

const PTY_HELPER = fileURLToPath(new URL("../bin/privacyai-pty.py", import.meta.url));

export async function launchNativeTui(flavor, userArgs = [], options = {}) {
  if (!new Set(["claude", "codex"]).has(flavor)) {
    throw new TypeError(`Unsupported native agent: ${flavor}`);
  }
  if (process.platform === "win32") {
    throw new Error("This prototype currently supports Linux and macOS. Windows ConPTY support is not implemented yet.");
  }

  validateNativeArguments(flavor, userArgs);

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
  const python = options.python || (await resolveExecutable("python3")) || (await resolveExecutable("python"));
  if (!python) throw new Error("PrivacyAI requires Python 3 for its transparent Unix PTY wrapper.");

  const runtimeDir = await mkdtemp(join(tmpdir(), "privacyai-agent-"));
  await chmod(runtimeDir, 0o700);
  const env = {
    ...process.env,
    ...options.env,
    PRIVACYAI_CONFIG_FILE: loaded.path,
    PRIVACYAI_WRAPPER_DIR: runtimeDir,
    PRIVACYAI_AGENT_FLAVOR: flavor
  };

  try {
    const isolation = await prepareAgentRuntimeIsolation(flavor, runtimeDir, { ...options, env });
    Object.assign(env, isolation.env);
    validateNativeEnvironment(flavor, env);
    const sanitizer = options.sanitizer || createPrivacySanitizer(loaded.config, options);
    let childArgs;
    let cwd = options.cwd || process.cwd();

    if (flavor === "claude") {
      const settingsPath = join(runtimeDir, "claude-settings.json");
      await writeClaudeSettings(settingsPath, options);
      await (options.auditClaudeStartupContext || auditClaudeStartupContext)({
        cwd,
        sanitizer,
        maxContextChars: options.startupContextMaxChars,
        maxFiles: options.startupContextMaxFiles
      });
      childArgs = ["--settings", settingsPath, ...isolation.args, ...userArgs];
    } else {
      cwd = resolve(codexEffectiveCwd(userArgs, cwd));
      const declarations = buildCodexHookDeclarationArgs(options);
      const trust = await discoverCodexHookTrust({
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
      childArgs = [...privacyArgs, ...userArgs];
    }

    return await spawnInherited(
      python,
      [PTY_HELPER, "--runtime-dir", runtimeDir, "--flavor", flavor, "--", binary, ...childArgs],
      { cwd, env }
    );
  } finally {
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

export function validateNativeArguments(flavor, args) {
  if (!Array.isArray(args)) throw new TypeError("Agent arguments must be an array.");

  if (flavor === "claude") {
    const isolatedFlags = new Set([
      "--settings",
      "--setting-sources",
      "--mcp-config",
      "--strict-mcp-config",
      "--plugin-dir",
      "--agents",
      "--tools",
      "--allowedTools",
      "--disallowedTools",
      "--system-prompt",
      "--append-system-prompt",
      "--continue",
      "-c",
      "--resume",
      "-r",
      "--fork-session",
      "--print",
      "-p",
      "--input-format",
      "--output-format",
      "--json-schema",
      "--replay-user-messages",
      "--session-id",
      "--from-pr",
      "--ide",
      "--chrome",
      "--dangerously-skip-permissions",
      "--disable-slash-commands"
    ]);
    for (const rawArg of args) {
      const arg = String(rawArg);
      if (arg === "--bare" || arg === "--safe-mode") {
        throw new Error(`PrivacyAI cannot launch Claude with ${arg} because it disables privacy hooks.`);
      }
      const flag = arg.split("=", 1)[0];
      if (isolatedFlags.has(flag)) {
        throw new Error(
          `PrivacyAI reserves Claude ${flag} while isolated startup context and privacy hooks are active.`
        );
      }
    }
    return;
  }

  if (flavor === "codex") {
    const blockedFlags = new Set([
      "--search",
      "-i",
      "--image",
      "--add-dir",
      "-p",
      "--profile",
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox"
    ]);
    const blockedCommands = new Set(["resume", "fork", "exec", "review", "mcp-server", "app-server"]);

    for (let index = 0; index < args.length; index += 1) {
      const arg = String(args[index]);
      const next = String(args[index + 1] || "");
      if (blockedCommands.has(arg)) {
        throw new Error(`PrivacyAI cannot launch Codex ${arg} because prior or implicit context bypasses this fresh-session boundary.`);
      }
      if (blockedFlags.has(arg) || [...blockedFlags].some(flag => arg.startsWith(`${flag}=`))) {
        throw new Error(`PrivacyAI reserves Codex ${arg.split("=", 1)[0]} while prompt-only isolation is active.`);
      }
      if (arg === "--enable" && next !== "hooks") {
        throw new Error(`PrivacyAI cannot enable Codex feature ${next || "<missing>"} in prompt-only isolation.`);
      }
      if (arg.startsWith("--enable=") && arg.slice("--enable=".length) !== "hooks") {
        throw new Error(`PrivacyAI cannot enable Codex feature ${arg.slice("--enable=".length)} in prompt-only isolation.`);
      }
      if (arg === "--disable" && next === "hooks") {
        throw new Error("PrivacyAI cannot launch Codex with hooks disabled.");
      }
      if (arg === "--disable=hooks") {
        throw new Error("PrivacyAI cannot launch Codex with hooks disabled.");
      }
      if ((arg === "-c" || arg === "--config") && /(^|\.)hooks(?:\.|=)|features\.hooks\s*=/.test(next)) {
        throw new Error("PrivacyAI reserves Codex hook configuration while privacy protection is active.");
      }
      if (/^--config=(?:.*\.)?hooks(?:\.|=)|^--config=features\.hooks=/.test(arg)) {
        throw new Error("PrivacyAI reserves Codex hook configuration while privacy protection is active.");
      }
      if (arg === "-c" || arg === "--config" || arg.startsWith("--config=")) {
        throw new Error("PrivacyAI reserves Codex configuration overrides while isolated startup context is active.");
      }
    }
  }
}

export function validateNativeEnvironment(flavor, env = process.env) {
  if (flavor !== "claude") return;

  for (const name of ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE"]) {
    if (isTruthyEnvironmentValue(env?.[name])) {
      throw new Error(`PrivacyAI cannot launch Claude while ${name} disables privacy hooks.`);
    }
  }
}

function isTruthyEnvironmentValue(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && !new Set(["0", "false", "no", "off"]).has(normalized);
}
