import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrivacyConfig } from "./config-store.js";
import { resolveExecutable } from "./executable.js";
import { checkPrivacyModel } from "./model-health.js";
import {
  buildCodexHookDeclarationArgs,
  codexEffectiveCwd,
  discoverCodexHookTrust,
  writeClaudeSettings
} from "./native-hooks.js";

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
    validateNativeEnvironment(flavor, env);
    let childArgs;
    let cwd = options.cwd || process.cwd();

    if (flavor === "claude") {
      const settingsPath = join(runtimeDir, "claude-settings.json");
      await writeClaudeSettings(settingsPath, options);
      childArgs = ["--settings", settingsPath, ...userArgs];
    } else {
      cwd = resolve(codexEffectiveCwd(userArgs, cwd));
      const declarations = buildCodexHookDeclarationArgs(options);
      const trust = await discoverCodexHookTrust({
        ...options,
        codexPath: binary,
        declarationArgs: declarations,
        cwd,
        env
      });
      childArgs = [...declarations, ...trust.stateArgs, ...userArgs];
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
    for (let index = 0; index < args.length; index += 1) {
      const arg = String(args[index]);
      if (arg === "--bare" || arg === "--safe-mode") {
        throw new Error(`PrivacyAI cannot launch Claude with ${arg} because it disables privacy hooks.`);
      }
      if (arg === "--settings" || arg.startsWith("--settings=")) {
        throw new Error("PrivacyAI cannot accept Claude --settings yet because it could replace the privacy hooks.");
      }
      if (arg === "--setting-sources" || arg.startsWith("--setting-sources=")) {
        throw new Error("PrivacyAI cannot override Claude setting sources while privacy protection is active.");
      }
    }
    return;
  }

  if (flavor === "codex") {
    for (let index = 0; index < args.length; index += 1) {
      const arg = String(args[index]);
      const next = String(args[index + 1] || "");
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
