import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { rebaseSessionAdditions as rebaseSdkSessionAdditions } from "@privacy-ai/sdk";
import { SessionVault } from "./session-vault.js";
import {
  openInstallationPrivacyIdentity,
  sessionPrivacyIdentity
} from "./privacy-identity.js";

export const REINJECT_MARKER_PREFIX = "PRIVACYAI_REINJECT:";

const SAFE_NATIVE_SLASH_COMMANDS = new Set([
  "clear",
  "doctor",
  "help",
  "login",
  "logout",
  "model",
  "permissions",
  "status",
  "theme"
]);

export async function processPromptSubmission(event, options = {}) {
  validatePromptEvent(event);
  const runtimeDir = resolveRequiredRuntimeDir(options.runtimeDir);
  const prompt = event.prompt;
  const sessionId = event.session_id;
  const identityRoot = await openInstallationPrivacyIdentity(options);
  const privacyIdentity = sessionPrivacyIdentity(identityRoot, sessionId);

  const nativeIngress = nativeContextIngress(prompt);
  if (nativeIngress) {
    return {
      output: {
        decision: "block",
        reason:
          `PrivacyAI blocked ${nativeIngress} because the native client expands it after prompt ` +
          "sanitization and before provider submission."
      }
    };
  }

  const slashCommand = nativeSlashCommandName(prompt);
  if (slashCommand) {
    if (SAFE_NATIVE_SLASH_COMMANDS.has(slashCommand) && isNativeSlashCommand(prompt)) return null;
    return {
      output: {
        decision: "block",
        reason:
          `PrivacyAI blocked /${slashCommand} because native slash commands can inject files, ` +
          "history, diffs, or other context after prompt sanitization."
      }
    };
  }
  if (await consumeAllowance(runtimeDir, sessionId, prompt, { identityRoot })) return null;

  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Prompt flow requires a sanitizer function.");
  }

  const vault = options.vault || new SessionVault({ ...options, identityRoot });
  const result = await options.sanitizer(prompt, {
    identity: privacyIdentity,
    artifactType: "native_prompt"
  });
  if (typeof result?.sanitizedPrompt !== "string") {
    throw new TypeError("Sanitizer did not return sanitizedPrompt.");
  }

  const rawSessionMap = normalizePromptSessionMap(result.sessionMap);
  const currentSnapshot = await vault.load(sessionId);
  assertPromptContainsNoMappedOriginals(result.sanitizedPrompt, {
    ...currentSnapshot.sessionMap,
    ...rawSessionMap
  });
  if (result.sanitizedPrompt === prompt && Object.keys(rawSessionMap).length === 0) {
    return null;
  }

  let sanitizedPrompt;
  let sessionMap;
  await vault.update(sessionId, current => {
    const rebased = rebaseSessionAdditions(
      result.sanitizedPrompt,
      rawSessionMap,
      current.sessionMap
    );
    sanitizedPrompt = rebased.sanitizedPrompt;
    sessionMap = rebased.sessionMap;
    assertPromptContainsNoMappedOriginals(sanitizedPrompt, {
      ...current.sessionMap,
      ...sessionMap
    });
    return { ...current.sessionMap, ...sessionMap };
  });

  if (sanitizedPrompt === prompt && Object.keys(sessionMap).length === 0) return null;

  const id = randomUUID();
  await writePrivateJson(join(runtimeDir, "pending", `${id}.json`), {
    id,
    sessionId,
    sanitizedPrompt,
    createdAt: new Date().toISOString()
  });
  await createAllowance(runtimeDir, sessionId, sanitizedPrompt, { identityRoot });

  return {
    id,
    sanitizedPrompt,
    output: {
      decision: "block",
      reason:
        `PrivacyAI sanitized this prompt locally and will resubmit it. ` +
        `[${REINJECT_MARKER_PREFIX}${id}]`
    }
  };
}

export function rebaseSessionAdditions(sanitizedPrompt, additions = {}, existing = {}) {
  const result = rebaseSdkSessionAdditions(sanitizedPrompt, additions, existing);
  return { sanitizedPrompt: result.sanitizedText, sessionMap: result.sessionMap };
}

export async function createAllowance(runtimeDir, sessionId, prompt, options = {}) {
  const path = allowancePath(runtimeDir, sessionId, prompt, options);
  await writePrivateJson(path, { createdAt: Date.now() });
  return path;
}

export async function consumeAllowance(runtimeDir, sessionId, prompt, options = {}) {
  const path = allowancePath(runtimeDir, sessionId, prompt, options);
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    await rm(path, { force: true });
    return Date.now() - Number(record.createdAt || 0) < 120000;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function allowancePath(runtimeDir, sessionId, prompt, options = {}) {
  const material = { version: 1, sessionId: String(sessionId), prompt: String(prompt) };
  const digest = options.identityRoot?.digest
    ? options.identityRoot.digest("runtime:prompt-allowance", material)
    : createHash("sha256").update(`${sessionId}\0${prompt}`).digest("hex");
  return join(resolveRequiredRuntimeDir(runtimeDir), "allow", `${digest}.json`);
}

export function isNativeSlashCommand(prompt) {
  return /^\s*\/[A-Za-z][A-Za-z0-9_-]*\s*$/.test(prompt);
}

function normalizePromptSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([placeholder, original]) =>
        typeof placeholder === "string" &&
        typeof original === "string" &&
        placeholder.length > 0 &&
        original.length > 0 &&
        placeholder !== original
    )
  );
}

function assertPromptContainsNoMappedOriginals(prompt, sessionMap) {
  let leakCount = 0;
  const normalizedPrompt = prompt.toLocaleLowerCase("en-US");
  for (const original of Object.values(sessionMap)) {
    if (normalizedPrompt.includes(original.toLocaleLowerCase("en-US"))) leakCount += 1;
  }
  if (leakCount === 0) return;

  const error = new Error(
    `PrivacyAI blocked prompt reinjection because ${leakCount} protected value(s) remained.`
  );
  error.code = "PRIVACYAI_PROMPT_LEAK";
  error.leakCount = leakCount;
  throw error;
}

function nativeContextIngress(prompt) {
  const value = String(prompt);
  if (/^\s*!/.test(value)) return "a native shell escape";
  if (/(^|[\s([{"'])@[^\s)\]}"',]+/.test(value)) {
    return "a native file/context mention";
  }
  return null;
}

function nativeSlashCommandName(prompt) {
  const match = String(prompt).match(/^\s*\/([A-Za-z][A-Za-z0-9_-]*)/);
  return match ? match[1].toLowerCase() : null;
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

function resolveRequiredRuntimeDir(value) {
  const runtimeDir = value || process.env.PRIVACYAI_WRAPPER_DIR;
  if (!runtimeDir) throw new TypeError("PrivacyAI wrapper runtime directory is missing.");
  return resolve(runtimeDir);
}

function validatePromptEvent(event) {
  if (!event || typeof event !== "object") throw new TypeError("Hook input must be an object.");
  if (event.hook_event_name !== "UserPromptSubmit") {
    throw new TypeError("Prompt hook received an unsupported event.");
  }
  if (typeof event.session_id !== "string" || !event.session_id) {
    throw new TypeError("Prompt hook requires a session id.");
  }
  if (typeof event.prompt !== "string") throw new TypeError("Prompt hook requires prompt text.");
}
