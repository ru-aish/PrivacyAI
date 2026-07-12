import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SessionVault } from "./session-vault.js";

export const REINJECT_MARKER_PREFIX = "PRIVACYAI_REINJECT:";

export async function processPromptSubmission(event, options = {}) {
  validatePromptEvent(event);
  const runtimeDir = resolveRequiredRuntimeDir(options.runtimeDir);
  const prompt = event.prompt;
  const sessionId = event.session_id;

  if (isNativeSlashCommand(prompt)) return null;
  if (await consumeAllowance(runtimeDir, sessionId, prompt)) return null;

  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Prompt flow requires a sanitizer function.");
  }

  const vault = options.vault || new SessionVault(options);
  const result = await options.sanitizer(prompt);
  let sanitizedPrompt;
  let sessionMap;

  await vault.update(sessionId, current => {
    const rebased = rebaseSessionAdditions(
      result?.sanitizedPrompt,
      result?.sessionMap || {},
      current.sessionMap
    );
    sanitizedPrompt = rebased.sanitizedPrompt;
    sessionMap = rebased.sessionMap;
    return { ...current.sessionMap, ...sessionMap };
  });

  if (typeof sanitizedPrompt !== "string") {
    throw new TypeError("Sanitizer did not return sanitizedPrompt.");
  }
  if (sanitizedPrompt === prompt && Object.keys(sessionMap).length === 0) return null;

  const id = randomUUID();
  await writePrivateJson(join(runtimeDir, "pending", `${id}.json`), {
    id,
    sessionId,
    sanitizedPrompt,
    createdAt: new Date().toISOString()
  });
  await createAllowance(runtimeDir, sessionId, sanitizedPrompt);

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
  if (typeof sanitizedPrompt !== "string") {
    throw new TypeError("Sanitizer did not return sanitizedPrompt.");
  }

  let text = sanitizedPrompt;
  const sessionMap = {};
  const occupied = new Set([...Object.keys(existing), ...Object.keys(additions)]);

  for (const [dummy, original] of Object.entries(additions)) {
    if (typeof dummy !== "string" || typeof original !== "string" || !dummy || !original) continue;

    let target = dummy;
    if (Object.hasOwn(existing, dummy) && existing[dummy] !== original) {
      target = allocatePrivatePlaceholder(dummy, occupied);
      text = text.split(dummy).join(target);
    }
    occupied.add(target);
    sessionMap[target] = original;
  }

  return { sanitizedPrompt: text, sessionMap };
}

function allocatePrivatePlaceholder(dummy, occupied) {
  const match = dummy.match(/^\[([A-Z][A-Z0-9_]*)_(\d+)\]$/);
  const type = match?.[1] || inferPlaceholderType(dummy);
  let index = match ? Number(match[2]) + 1 : 1;
  let candidate = `[${type}_${index}]`;
  while (occupied.has(candidate)) {
    index += 1;
    candidate = `[${type}_${index}]`;
  }
  return candidate;
}

function inferPlaceholderType(dummy) {
  if (/api|key|token|secret|credential/i.test(dummy)) return "API_KEY";
  if (/email/i.test(dummy)) return "EMAIL";
  if (/phone|555/.test(dummy)) return "PHONE";
  return "PRIVATE_VALUE";
}

export async function createAllowance(runtimeDir, sessionId, prompt) {
  const path = allowancePath(runtimeDir, sessionId, prompt);
  await writePrivateJson(path, { createdAt: Date.now() });
  return path;
}

export async function consumeAllowance(runtimeDir, sessionId, prompt) {
  const path = allowancePath(runtimeDir, sessionId, prompt);
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    await rm(path, { force: true });
    return Date.now() - Number(record.createdAt || 0) < 120000;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function allowancePath(runtimeDir, sessionId, prompt) {
  const digest = createHash("sha256").update(`${sessionId}\0${prompt}`).digest("hex");
  return join(resolveRequiredRuntimeDir(runtimeDir), "allow", `${digest}.json`);
}

export function isNativeSlashCommand(prompt) {
  return /^\s*\/[A-Za-z][A-Za-z0-9_-]*\s*$/.test(prompt);
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
