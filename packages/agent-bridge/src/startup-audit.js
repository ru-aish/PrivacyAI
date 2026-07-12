import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { assertNoProtectedOriginals, sanitizeModelVisibleValue } from "./context-gateway.js";

const DEFAULT_CAPTURE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_STATIC_LIMIT = 200000;
const DEFAULT_STATIC_FILES = 100;
const CLAUDE_INSTRUCTION_FILES = Object.freeze([
  "CLAUDE.md",
  "CLAUDE.local.md",
  join(".claude", "CLAUDE.md"),
  join(".claude", "settings.json"),
  join(".claude", "settings.local.json"),
  ".mcp.json"
]);
const CLAUDE_CONTEXT_DIRECTORIES = Object.freeze([
  join(".claude", "skills"),
  join(".claude", "commands"),
  join(".claude", "agents"),
  join(".claude", "plugins")
]);

export async function auditCodexStartupContext(options = {}) {
  if (!options.codexPath) throw new TypeError("Codex startup audit requires codexPath.");
  if (!options.cwd) throw new TypeError("Codex startup audit requires cwd.");
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Codex startup audit requires a local sanitizer.");
  }

  const canaryOriginal = options.canaryOriginal || `privacyai-provider-canary-${randomUUID()}`;
  const canaryPlaceholder =
    options.canaryPlaceholder ||
    `[PRIVACYAI_PROVIDER_CANARY_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}]`;
  const capture = options.capture || captureCodexPromptInput;
  const payload = await capture({
    codexPath: options.codexPath,
    args: options.args || [],
    cwd: options.cwd,
    env: options.env || process.env,
    prompt: canaryPlaceholder,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes
  });
  const serialized = JSON.stringify(payload);

  if (!serialized.includes(canaryPlaceholder)) {
    throw startupAuditError(
      "PRIVACYAI_CODEX_CAPTURE_INCOMPLETE",
      "PrivacyAI could not verify Codex's complete model-visible startup input."
    );
  }
  // The original exists only in local audit state. If it appears in the final
  // serialized prompt input, some boundary restored private data too early.
  assertNoProtectedOriginals(serialized, { [canaryPlaceholder]: canaryOriginal });

  const inspection = await inspectSerializedStartupContext(payload, {
    sanitizer: options.sanitizer,
    sessionMap: { [canaryPlaceholder]: canaryOriginal },
    maxContextChars: options.maxContextChars
  });
  throwIfHighRiskStartupValues(inspection.sessionMapAdditions, "Codex");

  return {
    itemCount: Array.isArray(payload) ? payload.length : 1,
    serializedBytes: Buffer.byteLength(serialized),
    canaryPlaceholder
  };
}

export async function auditClaudeStartupContext(options = {}) {
  if (!options.cwd) throw new TypeError("Claude startup audit requires cwd.");
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Claude startup audit requires a local sanitizer.");
  }

  const files = await collectClaudeStartupContext(options.cwd, options);
  if (files.length === 0) return { fileCount: 0, serializedBytes: 0 };

  const payload = files.map(file => ({
    path: relative(options.cwd, file.path) || basename(file.path),
    content: file.content
  }));
  const inspection = await inspectSerializedStartupContext(payload, {
    sanitizer: options.sanitizer,
    sessionMap: {},
    maxContextChars: options.maxContextChars || DEFAULT_STATIC_LIMIT
  });
  throwIfHighRiskStartupValues(inspection.sessionMapAdditions, "Claude");

  return {
    fileCount: files.length,
    serializedBytes: Buffer.byteLength(JSON.stringify(payload))
  };
}

export function captureCodexPromptInput(options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const maxBytes = Number(options.maxBytes || DEFAULT_CAPTURE_LIMIT);
    const args = [
      ...(options.args || []),
      "-C",
      resolve(options.cwd),
      "debug",
      "prompt-input",
      options.prompt
    ];
    const child = spawn(options.codexPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    const timer = setTimeout(() => {
      finish(startupAuditError(
        "PRIVACYAI_CODEX_CAPTURE_TIMEOUT",
        "PrivacyAI timed out while capturing Codex model-visible startup input."
      ));
    }, Number(options.timeoutMs || 20000));

    child.on("error", () => {
      finish(startupAuditError(
        "PRIVACYAI_CODEX_CAPTURE_FAILED",
        "PrivacyAI could not start Codex's local startup-input audit."
      ));
    });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        finish(startupAuditError(
          "PRIVACYAI_CODEX_CAPTURE_TOO_LARGE",
          "PrivacyAI blocked an unexpectedly large Codex startup context."
        ));
      }
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBytes) {
        finish(startupAuditError(
          "PRIVACYAI_CODEX_CAPTURE_TOO_LARGE",
          "PrivacyAI blocked excessive diagnostic output during Codex startup audit."
        ));
      }
    });
    child.on("exit", code => {
      if (settled) return;
      if (code !== 0) {
        finish(startupAuditError(
          "PRIVACYAI_CODEX_CAPTURE_FAILED",
          "PrivacyAI could not verify Codex's model-visible startup input."
        ));
        return;
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(startupAuditError(
          "PRIVACYAI_CODEX_CAPTURE_INVALID",
          "PrivacyAI received invalid Codex startup-input JSON."
        ));
      }
    });
  });
}

async function inspectSerializedStartupContext(value, options) {
  return sanitizeModelVisibleValue(value, {
    sanitizer: options.sanitizer,
    sessionMap: options.sessionMap,
    maxContextChars: options.maxContextChars || DEFAULT_STATIC_LIMIT
  });
}

function throwIfHighRiskStartupValues(additions, flavor) {
  const highRisk = Object.keys(additions).filter(isHighRiskPlaceholder);
  if (highRisk.length === 0) return;
  const error = startupAuditError(
    "PRIVACYAI_UNSAFE_STARTUP_CONTEXT",
    `PrivacyAI blocked ${flavor} startup because ${highRisk.length} high-risk private value(s) would enter model context before hooks.`
  );
  error.detectionCount = highRisk.length;
  throw error;
}

function isHighRiskPlaceholder(placeholder) {
  const normalized = String(placeholder).toUpperCase();
  return /(?:PASSWORD|SECRET|TOKEN|CREDENTIAL|API_KEY|AWS_ACCESS_KEY|EMAIL|PHONE|SSN|CREDIT_CARD|MEDICAL|MRN|PRIVATE_IDENTIFIER|PRIVATE_VALUE|PERSON)/.test(normalized);
}

async function collectClaudeStartupContext(cwd, options) {
  const root = await findProjectRoot(cwd);
  const files = [];
  const seen = new Set();
  const maxFiles = Number(options.maxFiles || DEFAULT_STATIC_FILES);
  const maxBytes = Number(options.maxContextChars || DEFAULT_STATIC_LIMIT);
  let totalBytes = 0;

  for (const directory of ancestors(resolve(cwd), root)) {
    for (const name of CLAUDE_INSTRUCTION_FILES) {
      await addFile(join(directory, name));
    }
    for (const name of CLAUDE_CONTEXT_DIRECTORIES) {
      await addDirectory(join(directory, name));
    }
  }
  return files;

  async function addDirectory(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await addDirectory(child);
      else if (entry.isFile()) await addFile(child);
      if (files.length > maxFiles) throw staticContextTooLargeError();
    }
  }

  async function addFile(path) {
    if (seen.has(path)) return;
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
    if (metadata.size > maxBytes || totalBytes + metadata.size > maxBytes) {
      throw staticContextTooLargeError();
    }
    const content = await readFile(path, "utf8");
    totalBytes += Buffer.byteLength(content);
    seen.add(path);
    files.push({ path, content });
  }
}

async function findProjectRoot(cwd) {
  let current = resolve(cwd);
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function ancestors(start, root) {
  const result = [];
  let current = start;
  while (true) {
    result.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function staticContextTooLargeError() {
  return startupAuditError(
    "PRIVACYAI_STARTUP_CONTEXT_TOO_LARGE",
    "PrivacyAI blocked startup because implicit project context was too large to classify atomically."
  );
}

function startupAuditError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
