import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrivacyConfig } from "./config-store.js";
import { resolveExecutable } from "./executable.js";
import { checkPrivacyModel, privacyModelHealthError } from "./model-health.js";
import {
  createPrivacySanitizer,
  derivePrivacyContextMaxChars,
  derivePrivacyContextMaxTokens
} from "./privacy-sanitizer.js";
import { isSameLiveProcess, readProcessStartIdentity } from "./process-identity.js";
import { startAgyTransportRuntime } from "./agy-transport-runtime.js";

const AGY_HOOK_PATH = fileURLToPath(new URL("../bin/privacyai-agy-hook.js", import.meta.url));
const HOOK_PREFIX = "privacyai-agent-bridge-";
const PROMPT_FLAGS = new Set(["-p", "--print", "--prompt"]);
const FORBIDDEN_FLAGS = new Set([
  "-c",
  "--continue",
  "--conversation",
  "-i",
  "--prompt-interactive",
  "--dangerously-skip-permissions"
]);

export async function launchAgy(userArgs = [], options = {}) {
  if (process.platform === "win32") {
    throw new Error("PrivacyAI AGY support currently requires Linux or macOS.");
  }

  const privacyMode = parseAgyPrivacyMode(userArgs);
  const loadConfig = options.loadPrivacyConfig || loadPrivacyConfig;
  const loaded = await loadConfig({ path: options.configPath });
  if (!loaded.configured) throw onboardingRequiredError();

  const checkHealth = options.checkPrivacyModel || checkPrivacyModel;
  const health = await checkHealth(loaded.config, {
    probeCompletion: true,
    ...options.healthOptions
  });
  if (!health.ok) throw privacyModelHealthError(health);

  const binary = options.binary || await resolveAgyExecutable(options);
  if (!binary) {
    throw new Error("agy is not installed or is not available on PATH or ~/.local/bin.");
  }

  const sanitizer = options.sanitizer || createPrivacySanitizer(loaded.config, options);
  if (privacyMode.mode === "strict") {
    return launchAgyStrict(privacyMode.args, {
      ...options,
      binary,
      loaded,
      sanitizer
    });
  }

  const baseEnv = agyBaseEnvironment(options);
  const output = options.stderr || process.stderr;
  const onProxyError = options.onProxyError || (event => {
    output.write(
      `[PrivacyAI] AGY transport stopped a request (${event.phase}: ${event.code}).\n`
    );
  });
  const startRuntime = options.startAgyTransportRuntime || startAgyTransportRuntime;
  const runtime = await startRuntime({
    ...options,
    sanitizer,
    baseEnv,
    maxContextChars:
      options.maxContextChars ?? derivePrivacyContextMaxChars(loaded.config, options),
    maxContextTokens:
      options.maxContextTokens ?? derivePrivacyContextMaxTokens(loaded.config, options),
    tokenCounter: options.tokenCounter,
    onProxyError
  });
  try {
    output.write(
      "PrivacyAI AGY transport active: native tools and integrations remain available; " +
      "supported model-bound content is sanitized locally.\n"
    );
    const runChild = options.runChild || spawnInherited;
    return await runChild(binary, privacyMode.args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...baseEnv,
        ...runtime.env,
        PRIVACYAI_CONFIG_FILE: loaded.path,
        PRIVACYAI_AGENT_FLAVOR: "agy",
        PRIVACYAI_AGY_PRIVACY_MODE: "transport"
      }
    });
  } finally {
    await runtime.close();
  }
}

export function parseAgyPrivacyMode(args) {
  if (!Array.isArray(args)) throw new TypeError("AGY arguments must be an array.");
  const explicit = [];
  const forwarded = [];
  for (const raw of args) {
    const arg = String(raw);
    if (arg === "--privacy-transport" || arg === "--privacy-gateway") {
      explicit.push("transport");
      continue;
    }
    if (arg === "--privacy-strict") {
      explicit.push("strict");
      continue;
    }
    forwarded.push(raw);
  }
  if (new Set(explicit).size > 1) {
    throw new Error("Choose only one AGY privacy mode: --privacy-transport or --privacy-strict.");
  }
  return { mode: explicit[0] || "transport", args: forwarded };
}

async function launchAgyStrict(userArgs, options) {
  const parsed = parseAgyArguments(userArgs);
  const result = await options.sanitizer(parsed.prompt);
  if (!result || typeof result.sanitizedPrompt !== "string") {
    throw new TypeError("PrivacyAI sanitizer did not return sanitizedPrompt for AGY.");
  }

  const runtimeDir = await mkdtemp(join(options.tmpDir || tmpdir(), "privacyai-agy-"));
  let cleanupHook = null;
  try {
    await chmod(runtimeDir, 0o700);
    const sessionToken = options.sessionToken || randomUUID();
    const mapPath = join(runtimeDir, "session-map.json");
    await writeFile(
      mapPath,
      `${JSON.stringify({ sessionToken, sessionMap: result.sessionMap || {} })}\n`,
      { mode: 0o600 }
    );

    const childArgs = [...userArgs];
    replacePrompt(childArgs, parsed, result.sanitizedPrompt);
    const env = {
      ...agyBaseEnvironment(options),
      PRIVACYAI_CONFIG_FILE: options.loaded.path,
      PRIVACYAI_AGENT_FLAVOR: "agy",
      PRIVACYAI_AGY_PRIVACY_MODE: "strict",
      PRIVACYAI_AGY_SESSION_TOKEN: sessionToken,
      PRIVACYAI_WRAPPER_DIR: runtimeDir
    };
    const installHook = options.installAgyGlobalHook || installAgyGlobalHook;

    cleanupHook = await installHook({
      ...options,
      mapPath,
      sessionToken,
      runtimeDir,
      env
    });

    const output = options.stderr || process.stderr;
    output.write(
      "PrivacyAI AGY strict mode: prompt checked locally; tools are isolated because " +
      "the transport boundary was explicitly disabled.\n"
    );

    const runChild = options.runChild || spawnInherited;
    return await runChild(options.binary, childArgs, {
      cwd: options.cwd || process.cwd(),
      env
    });
  } finally {
    try {
      if (cleanupHook) await cleanupHook();
    } finally {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}
export function parseAgyArguments(args) {
  if (!Array.isArray(args)) throw new TypeError("AGY arguments must be an array.");

  let prompt = null;
  let promptIndex = -1;
  let promptStyle = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (isForbiddenArgument(arg)) throw unsupportedAgyModeError(arg);

    if (PROMPT_FLAGS.has(arg)) {
      if (prompt !== null) throw new Error("PrivacyAI AGY accepts exactly one prompt flag.");
      if (index + 1 >= args.length) throw new Error(`${arg} requires a prompt value.`);
      prompt = String(args[index + 1]);
      promptIndex = index + 1;
      promptStyle = "separate";
      index += 1;
      continue;
    }

    const inline = arg.match(/^(--print|--prompt|-p)=(.*)$/s);
    if (inline) {
      if (prompt !== null) throw new Error("PrivacyAI AGY accepts exactly one prompt flag.");
      prompt = inline[2];
      promptIndex = index;
      promptStyle = `inline:${inline[1]}`;
    }
  }

  if (prompt === null) {
    throw new Error(
      "PrivacyAI AGY currently supports protected one-shot prompts only. " +
      "Use: privacyai agy --print \"your prompt\""
    );
  }

  return { prompt, promptIndex, promptStyle };
}

export function buildAgyHookConfig(options) {
  if (!options?.mapPath) throw new TypeError("AGY hook configuration requires mapPath.");
  const hookName = options.hookName || `${HOOK_PREFIX}${process.pid}`;
  const nodePath = options.nodePath || process.execPath;
  const command = [
    nodePath,
    AGY_HOOK_PATH,
    "--session-map",
    options.mapPath
  ].map(shellQuote).join(" ");

  return {
    [hookName]: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command,
              timeout: Number(options.toolTimeout || 30)
            }
          ]
        }
      ]
    }
  };
}

export async function installAgyGlobalHook(options) {
  if (!options?.mapPath) throw new TypeError("AGY hook installation requires mapPath.");
  if (!options?.sessionToken) throw new TypeError("AGY hook installation requires sessionToken.");
  const hooksPath = options.hooksPath || join(options.homeDir || homedir(), ".gemini", "config", "hooks.json");
  const lockPath = options.lockPath || `${hooksPath}.privacyai.lock`;
  await mkdir(dirname(hooksPath), { recursive: true, mode: 0o700 });
  const releaseLock = await acquireFileLock(lockPath, options);

  let originalBytes = null;
  let originalMode = 0o600;
  try {
    try {
      originalBytes = await readFile(hooksPath);
      originalMode = (await stat(hooksPath)).mode & 0o777;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const originalObject = parseHooksObject(originalBytes, hooksPath);
    const baseObject = removePrivacyAiHooks(originalObject);
    const hookName = options.hookName || `${HOOK_PREFIX}${process.pid}-${Date.now()}`;
    const installedObject = {
      ...baseObject,
      ...buildAgyHookConfig({ ...options, hookName })
    };
    await atomicWriteJson(hooksPath, installedObject, 0o600);

    let cleaned = false;
    return async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        const currentBytes = await readFile(hooksPath);
        const currentObject = parseHooksObject(currentBytes, hooksPath);
        const withoutCurrentHook = { ...currentObject };
        delete withoutCurrentHook[hookName];

        if (deepEqual(withoutCurrentHook, originalObject)) {
          if (originalBytes) await atomicWriteBytes(hooksPath, originalBytes, originalMode || 0o600);
          else await rm(hooksPath, { force: true });
        } else if (Object.keys(withoutCurrentHook).length === 0 && !originalBytes) {
          await rm(hooksPath, { force: true });
        } else {
          await atomicWriteJson(hooksPath, withoutCurrentHook, originalMode || 0o600);
        }
      } finally {
        await releaseLock();
      }
    };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

function agyBaseEnvironment(options = {}) {
  const env = { ...process.env, ...options.env };
  if (!env.GEMINI_DIR) env.GEMINI_DIR = join(options.homeDir || homedir(), ".gemini");
  return env;
}

async function resolveAgyExecutable(options) {
  const fromPath = await (options.resolveExecutable || resolveExecutable)("agy");
  if (fromPath) return fromPath;
  const candidate = join(options.homeDir || homedir(), ".local", "bin", "agy");
  try {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function replacePrompt(args, parsed, sanitizedPrompt) {
  if (parsed.promptStyle === "separate") {
    args[parsed.promptIndex] = sanitizedPrompt;
    return;
  }
  const flag = parsed.promptStyle.slice("inline:".length);
  args[parsed.promptIndex] = `${flag}=${sanitizedPrompt}`;
}

function isForbiddenArgument(arg) {
  if (FORBIDDEN_FLAGS.has(arg)) return true;
  return [
    "--continue=",
    "--conversation=",
    "--prompt-interactive=",
    "--dangerously-skip-permissions="
  ].some(prefix => arg.startsWith(prefix));
}

function unsupportedAgyModeError(flag) {
  return new Error(
    `PrivacyAI cannot launch AGY with ${flag}. The current AGY API has no ` +
    "UserPromptSubmit hook and cannot rewrite tool inputs or outputs, so only " +
    "fresh one-shot prompts are supported safely."
  );
}

async function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = Number(options.lockTimeoutMs || 10000);
  const retryMs = Number(options.lockRetryMs || 50);
  const started = Date.now();

  while (true) {
    try {
      const owner = `${JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        token: randomUUID(),
        processStart: await readProcessStartIdentity(process.pid)
      })}\n`;
      await writeFile(lockPath, owner, { flag: "wx", mode: 0o600 });
      return async () => {
        await removeLockIfUnchanged(lockPath, owner);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() - started >= timeoutMs) {
        throw new Error("Timed out waiting for another PrivacyAI AGY session to release its hook lock.");
      }
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
}

async function removeStaleLock(lockPath) {
  let serialized;
  let record;
  try {
    serialized = await readFile(lockPath, "utf8");
    const trimmed = serialized.trim();
    record = trimmed.startsWith("{")
      ? JSON.parse(trimmed)
      : { pid: Number(trimmed), createdAt: 0, token: "legacy" };
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }

  if (await isSameLiveProcess(record)) return false;
  return removeLockIfUnchanged(lockPath, serialized);
}

async function removeLockIfUnchanged(lockPath, expected) {
  try {
    if (await readFile(lockPath, "utf8") !== expected) return false;
    await rm(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function parseHooksObject(bytes, hooksPath) {
  if (!bytes) return {};
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`PrivacyAI refused to replace invalid AGY hooks JSON at ${hooksPath}.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`PrivacyAI refused to replace non-object AGY hooks JSON at ${hooksPath}.`);
  }
  return value;
}

function removePrivacyAiHooks(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => !name.startsWith(HOOK_PREFIX))
  );
}

async function atomicWriteJson(path, value, mode) {
  await atomicWriteBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode);
}

async function atomicWriteBytes(path, bytes, mode) {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, bytes, { mode });
  await chmod(tempPath, mode);
  await rename(tempPath, path);
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
