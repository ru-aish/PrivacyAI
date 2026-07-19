import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { localSanitize } from "@privacy-ai/sdk";

import { assertNoProtectedOriginals, sanitizeModelVisibleValue } from "./context-gateway.js";
import { buildCodexRequestVerificationSeed } from "./codex-request-transform.js";
import { detachedProcessOptions, terminateProcessTree } from "./process-supervisor.js";
import { resolveStartupFileManifest, sanitizeStartupFiles } from "./startup-cache.js";

const DEFAULT_CAPTURE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_CAPTURE_TIMEOUT_MS = 90000;
const CAPTURE_TIMEOUT_MARGIN_MS = 30000;
const MAX_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_MCP_STARTUP_TIMEOUT_MS = 10000;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_STATIC_LIMIT = 200000;
const DEFAULT_STATIC_FILES = 100;
const DEFAULT_CODEX_STATIC_LIMIT = 2 * 1024 * 1024;
const DEFAULT_CODEX_STATIC_FILES = 1000;
const CODEX_STATIC_TEXT_EXTENSIONS = new Set([
  ".json", ".md", ".rules", ".toml", ".txt", ".yaml", ".yml"
]);
const CODEX_HOME_FILES = Object.freeze(["AGENTS.md", "AGENTS.override.md", "config.toml"]);
const CODEX_HOME_DIRECTORIES = Object.freeze(["rules", "skills"]);
const CODEX_PROJECT_FILES = Object.freeze([
  "AGENTS.md",
  "AGENTS.override.md",
  join(".codex", "AGENTS.md"),
  join(".codex", "AGENTS.override.md"),
  join(".codex", "config.toml")
]);
const CODEX_PROJECT_DIRECTORIES = Object.freeze([
  join(".codex", "rules"),
  join(".codex", "skills")
]);
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

/**
 * Classify every locally discoverable Codex startup source before any Codex
 * subprocess is allowed to start. The rendered prompt audit still runs later,
 * but only after this static boundary has succeeded.
 */
export async function auditCodexStaticStartupContext(options = {}) {
  if (!options.cwd) throw new TypeError("Codex static startup audit requires cwd.");
  const staticSanitizer = options.staticSanitizer || (async text => {
    const result = await localSanitize(text);
    return {
      sanitizedPrompt: result.sanitizedText,
      sessionMap: result.sessionMap
    };
  });
  if (typeof staticSanitizer !== "function") {
    throw new TypeError("Codex static startup audit requires a deterministic local sanitizer.");
  }

  const roots = await codexStaticRoots(options.cwd, options);
  const manifest = await collectCodexStaticStartupContext(options.cwd, { ...options, roots });
  if (manifest.records.length === 0) return { fileCount: 0, serializedBytes: 0, sessionMapAdditions: {}, manifestHash: manifest.manifestHash, counters: manifest.counters };
  const staticResult = await sanitizeStartupFiles(manifest, {
    verificationStore: options.verificationStore,
    policyFingerprint: String(options.policyFingerprint || "startup-context-v1"),
    sanitizer: staticSanitizer
  });
  const sessionMapAdditions = staticResult.sessionMapAdditions;
  if (options.blockHighRisk !== false) {
    throwIfHighRiskStartupValues(sessionMapAdditions, "Codex");
  }

  return {
    fileCount: manifest.records.length,
    serializedBytes: manifest.records.reduce((total, file) => total + file.metadata.size, 0),
    sessionMapAdditions,
    manifestHash: manifest.manifestHash,
    repositoryId: manifest.repositoryId,
    worktreeId: manifest.worktreeId,
    counters: { ...manifest.counters, sanitizerCalls: staticResult.sanitizerCalls }
  };
}

export async function auditCodexStartupContext(options = {}) {
  if (!options.codexPath) throw new TypeError("Codex startup audit requires codexPath.");
  if (!options.cwd) throw new TypeError("Codex startup audit requires cwd.");
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Codex startup audit requires a local sanitizer.");
  }

  // A rendered fingerprint is only supplied by the launcher after it has
  // identified every local startup input and the executable.  It is a proof
  // cache, not a heuristic: any relevant change selects a new key.
  if (options.renderedFingerprint && options.verificationStore) {
    const cached = options.verificationStore.getVerification(options.renderedFingerprint, String(options.policyFingerprint || "startup-context-v1"));
    if (cached) {
      return { itemCount: cached.itemCount || 0, serializedBytes: cached.serializedBytes || 0, primedItemCount: 0, sessionMapAdditions: cached.sessionMapAdditions || {}, cache: { hit: true, reason: "rendered-startup-fingerprint" } };
    }
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
    maxContextChars: options.maxContextChars,
    verificationStore: options.verificationStore,
    policyFingerprint: options.policyFingerprint,
    cacheCanonicalReplacements: {
      [canaryPlaceholder]: "[PRIVACYAI_STARTUP_CANARY]"
    }
  });
  if (options.blockHighRisk !== false) {
    throwIfHighRiskStartupValues(inspection.sessionMapAdditions, "Codex");
  }

  let primedItemCount = 0;
  if (options.primeRequestCache === true && options.verificationStore) {
    primedItemCount = primeCodexRenderedVerification(payload, {
      verificationStore: options.verificationStore,
      policyFingerprint: options.policyFingerprint,
      // The canary proves the renderer kept private originals local, but it is
      // deliberately excluded from persistent request-cache records. Only
      // genuine discoveries from the rendered startup context are retained.
      sessionMap: inspection.sessionMapAdditions
    });
  }

  const output = {
    itemCount: Array.isArray(payload) ? payload.length : 1,
    serializedBytes: Buffer.byteLength(serialized),
    canaryPlaceholder,
    primedItemCount,
    sessionMapAdditions: inspection.sessionMapAdditions,
    cache: { hit: false, reason: options.renderedFingerprint ? "rendered-startup-fingerprint-miss" : "no-rendered-fingerprint" }
  };
  if (options.renderedFingerprint && options.verificationStore) {
    options.verificationStore.putVerification({
      cacheKey: options.renderedFingerprint,
      contentHash: options.renderedFingerprint,
      artifactType: "rendered_startup",
      policyFingerprint: String(options.policyFingerprint || "startup-context-v1"),
      sessionMapAdditions: inspection.sessionMapAdditions,
      itemCount: output.itemCount,
      serializedBytes: output.serializedBytes
    });
  }
  return output;
}

export async function auditClaudeStartupContext(options = {}) {
  if (!options.cwd) throw new TypeError("Claude startup audit requires cwd.");
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Claude startup audit requires a local sanitizer.");
  }

  const manifest = await collectClaudeStartupContext(options.cwd, options);
  if (manifest.records.length === 0) {
    return {
      fileCount: 0,
      serializedBytes: 0,
      sessionMapAdditions: {},
      manifestHash: manifest.manifestHash,
      repositoryId: manifest.repositoryId,
      worktreeId: manifest.worktreeId,
      counters: { ...manifest.counters, sanitizerCalls: 0 }
    };
  }

  const inspection = await sanitizeStartupFiles(manifest, {
    sanitizer: options.sanitizer,
    verificationStore: options.verificationStore,
    policyFingerprint: String(options.policyFingerprint || "startup-context-v1")
  });
  throwIfHighRiskStartupValues(inspection.sessionMapAdditions, "Claude");

  return {
    fileCount: manifest.records.length,
    serializedBytes: manifest.records.reduce(
      (total, file) => total + file.metadata.size,
      0
    ),
    sessionMapAdditions: inspection.sessionMapAdditions,
    manifestHash: manifest.manifestHash,
    repositoryId: manifest.repositoryId,
    worktreeId: manifest.worktreeId,
    counters: {
      ...manifest.counters,
      sanitizerCalls: inspection.sanitizerCalls
    }
  };
}

export async function captureCodexPromptInput(options) {
  const timeoutMs = await resolveCodexCaptureTimeoutMs(options);
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
    const child = spawn(options.codexPath, args, detachedProcessOptions({
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    }));
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateProcessTree(child, { graceMs: 250, killWaitMs: 750 }).then(
        () => error ? rejectPromise(error) : resolvePromise(value),
        cleanupError => rejectPromise(error || cleanupError)
      );
    };

    const timer = setTimeout(() => {
      finish(startupAuditError(
        "PRIVACYAI_CODEX_CAPTURE_TIMEOUT",
        `PrivacyAI timed out after ${Math.ceil(timeoutMs / 1000)} seconds while capturing Codex model-visible startup input.`
      ));
    }, timeoutMs);

    child.on("error", () => {
      finish(startupAuditError(
        "PRIVACYAI_CODEX_CAPTURE_FAILED",
        "PrivacyAI could not start Codex's local startup-input audit."
      ));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > maxBytes) {
        finish(startupAuditError(
          "PRIVACYAI_CODEX_CAPTURE_TOO_LARGE",
          "PrivacyAI blocked an unexpectedly large Codex startup context."
        ));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr += chunk;
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > maxBytes) {
        finish(startupAuditError(
          "PRIVACYAI_CODEX_CAPTURE_TOO_LARGE",
          "PrivacyAI blocked excessive diagnostic output during Codex startup audit."
        ));
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(codexCaptureFailure(stderr, code, signal));
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

export async function resolveCodexCaptureTimeoutMs(options = {}) {
  if (options.timeoutMs != null) {
    return positiveTimeoutMs(options.timeoutMs, "Codex startup audit timeout");
  }

  const env = options.env || process.env;
  if (env.PRIVACYAI_STARTUP_AUDIT_TIMEOUT_MS != null) {
    return positiveTimeoutMs(
      env.PRIVACYAI_STARTUP_AUDIT_TIMEOUT_MS,
      "PRIVACYAI_STARTUP_AUDIT_TIMEOUT_MS"
    );
  }

  const configuredMcpTimeoutMs = await configuredCodexMcpStartupTimeoutMs(options);
  return Math.min(
    MAX_CAPTURE_TIMEOUT_MS,
    Math.max(DEFAULT_CAPTURE_TIMEOUT_MS, configuredMcpTimeoutMs + CAPTURE_TIMEOUT_MARGIN_MS)
  );
}

async function configuredCodexMcpStartupTimeoutMs(options) {
  const cwd = resolve(options.cwd || process.cwd());
  const roots = await codexStaticRoots(cwd, options);
  const paths = new Set([join(roots.codexHome, "config.toml")]);
  for (const directory of ancestors(cwd, roots.projectRoot)) {
    paths.add(join(directory, ".codex", "config.toml"));
  }

  let maximum = 0;
  for (const path of paths) {
    const content = await readSmallRegularFile(path, MAX_CODEX_CONFIG_BYTES);
    if (content == null) continue;
    for (const timeoutMs of parseCodexMcpStartupTimeouts(content)) {
      maximum = Math.max(maximum, timeoutMs);
    }
  }
  return maximum;
}

function parseCodexMcpStartupTimeouts(content) {
  const timeouts = new Map();
  let currentServer = null;
  const serverTable = /^\s*\[\s*mcp_servers\.((?:"(?:\\.|[^"])+")|(?:'[^']+')|(?:[A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
  const timeoutEntry = /^\s*startup_timeout_sec\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:#.*)?$/;

  for (const line of String(content).split(/\r?\n/)) {
    const table = line.match(serverTable);
    if (table) {
      currentServer = table[1];
      if (!timeouts.has(currentServer)) {
        timeouts.set(currentServer, DEFAULT_CODEX_MCP_STARTUP_TIMEOUT_MS);
      }
      continue;
    }
    if (/^\s*\[/.test(line)) {
      currentServer = null;
      continue;
    }
    if (!currentServer) continue;
    const timeout = line.match(timeoutEntry);
    if (!timeout) continue;
    timeouts.set(currentServer, Math.ceil(Number(timeout[1]) * 1000));
  }
  return timeouts.values();
}

async function readSmallRegularFile(path, maxBytes) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) return null;
  return readFile(path, "utf8");
}

function positiveTimeoutMs(value, label) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`${label} must be a positive number of milliseconds.`);
  }
  return Math.ceil(timeoutMs);
}

async function inspectSerializedStartupContext(value, options) {
  const policyFingerprint = String(options.policyFingerprint || "startup-context-v1");
  const serialized = JSON.stringify(value);
  const canonical = canonicalizeCacheText(serialized, options.cacheCanonicalReplacements);
  const contentHash = createHash("sha256").update(canonical).digest("hex");
  const cacheKey = createHash("sha256")
    .update(policyFingerprint)
    .update("\0startup_context\0")
    .update(contentHash)
    .digest("hex");
  const cached = options.verificationStore?.getVerification(cacheKey, policyFingerprint);
  if (cached) {
    return {
      value,
      sessionMapAdditions: cached.sessionMapAdditions || {},
      changed: Object.keys(cached.sessionMapAdditions || {}).length > 0
    };
  }

  const result = await sanitizeModelVisibleValue(value, {
    sanitizer: options.sanitizer,
    sessionMap: options.sessionMap,
    maxContextChars: options.maxContextChars || DEFAULT_STATIC_LIMIT
  });
  options.verificationStore?.putVerification({
    cacheKey,
    contentHash,
    artifactType: "startup_context",
    policyFingerprint,
    sessionMapAdditions: result.sessionMapAdditions
  });
  return result;
}

function canonicalizeCacheText(text, replacements = {}) {
  let canonical = text;
  for (const [value, replacement] of Object.entries(replacements || {})) {
    canonical = canonical.split(value).join(replacement);
  }
  return canonical;
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

function primeCodexRenderedVerification(payload, options) {
  const policyFingerprint = String(options.policyFingerprint || "startup-context-v1");
  const sessionKey = "codex-provider:privacyai-startup-preflight";
  const body = {
    model: "privacyai-startup-preflight",
    input: Array.isArray(payload) ? payload : [payload],
    stream: false,
    store: false,
    client_metadata: { thread_id: "privacyai-startup-preflight" }
  };
  const seed = buildCodexRequestVerificationSeed(body, options.sessionMap, {
    policyFingerprint
  });

  options.verificationStore.saveThread(sessionKey, {
    parentSessionKeys: [],
    sessionMap: options.sessionMap,
    policyFingerprint
  });
  for (const [, record] of seed.cacheWrites) {
    options.verificationStore.putVerification(record);
  }
  for (const item of seed.itemRecords) {
    options.verificationStore.recordThreadItem({ ...item, sessionKey });
  }
  options.verificationStore.prune();
  return seed.itemRecords.length;
}

async function collectCodexStaticStartupContext(cwd, options) {
  const roots = options.roots || await codexStaticRoots(cwd, options);
  const files = [];
  const seen = new Set();
  const maxFiles = Number(options.maxFiles || DEFAULT_CODEX_STATIC_FILES);
  const maxBytes = Number(options.maxBytes || DEFAULT_CODEX_STATIC_LIMIT);
  const maxEntries = startupTraversalBudget(maxFiles);
  let traversedEntries = 0;

  for (const name of CODEX_HOME_FILES) await addFile(join(roots.codexHome, name));
  for (const name of CODEX_HOME_DIRECTORIES) await addDirectory(join(roots.codexHome, name));
  for (const directory of ancestors(resolve(cwd), roots.projectRoot)) {
    for (const name of CODEX_PROJECT_FILES) await addFile(join(directory, name));
    for (const name of CODEX_PROJECT_DIRECTORIES) await addDirectory(join(directory, name));
  }
  const manifest = await resolveStartupFileManifest(files, {
    cwd,
    verificationStore: options.verificationStore,
    maxFiles,
    maxBytes
  });
  return manifest;

  async function addDirectory(path) {
    let directory;
    try {
      directory = await opendir(path);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw error;
    }
    for await (const entry of directory) {
      traversedEntries += 1;
      if (traversedEntries > maxEntries) throw staticContextTooLargeError();
      const child = join(path, entry.name);
      if (entry.isDirectory()) await addDirectory(child);
      else if (entry.isFile() && isCodexStaticTextFile(child)) await addFile(child);
      if (files.length > maxFiles) throw staticContextTooLargeError();
    }
  }

  async function addFile(path) {
    if (seen.has(path)) return;
    // Existence, type, symlink and size validation happen once in the manifest
    // resolver. Avoid a duplicate lstat for every startup file.
    seen.add(path);
    files.push(path);
  }
}

async function codexStaticRoots(cwd, options = {}) {
  const env = options.env || process.env;
  return {
    projectRoot: options.projectRoot || await findProjectRoot(cwd),
    codexHome: resolve(options.codexHome || env.CODEX_HOME || join(homedir(), ".codex"))
  };
}

function displayStaticPath(path, roots) {
  const fromCodexHome = relative(roots.codexHome, path);
  if (fromCodexHome && !fromCodexHome.startsWith("..")) {
    return join("<CODEX_HOME>", fromCodexHome);
  }
  return relative(roots.projectRoot, path) || basename(path);
}

function isCodexStaticTextFile(path) {
  return CODEX_STATIC_TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

async function collectClaudeStartupContext(cwd, options) {
  const root = await findProjectRoot(cwd);
  const paths = [];
  const seen = new Set();
  const maxFiles = Number(options.maxFiles || DEFAULT_STATIC_FILES);
  const maxBytes = Number(options.maxContextChars || DEFAULT_STATIC_LIMIT);
  const maxEntries = startupTraversalBudget(maxFiles);
  let traversedEntries = 0;

  for (const directory of ancestors(resolve(cwd), root)) {
    for (const name of CLAUDE_INSTRUCTION_FILES) {
      await addFile(join(directory, name));
    }
    for (const name of CLAUDE_CONTEXT_DIRECTORIES) {
      await addDirectory(join(directory, name));
    }
  }

  const manifest = await resolveStartupFileManifest(paths, {
    cwd,
    verificationStore: options.verificationStore,
    maxFiles,
    maxBytes
  });
  return manifest;

  async function addDirectory(path) {
    let directory;
    try {
      directory = await opendir(path);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw error;
    }
    for await (const entry of directory) {
      traversedEntries += 1;
      if (traversedEntries > maxEntries) throw staticContextTooLargeError();
      const child = join(path, entry.name);
      if (entry.isDirectory()) await addDirectory(child);
      else if (entry.isFile()) await addFile(child);
      if (paths.length > maxFiles) throw staticContextTooLargeError();
    }
  }

  async function addFile(path) {
    if (seen.has(path)) return;
    seen.add(path);
    paths.push(path);
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

function startupTraversalBudget(maxFiles) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new TypeError("startup context maxFiles must be a positive safe integer.");
  }
  return Math.min(Number.MAX_SAFE_INTEGER, maxFiles * 32);
}

function staticContextTooLargeError() {
  return startupAuditError(
    "PRIVACYAI_STARTUP_CONTEXT_TOO_LARGE",
    "PrivacyAI blocked startup because implicit project context was too large to classify atomically."
  );
}

function codexCaptureFailure(stderr, code, signal) {
  if (/Missing optional dependency @openai\/codex-[A-Za-z0-9_-]+/i.test(stderr)) {
    return startupAuditError(
      "PRIVACYAI_CODEX_EXECUTABLE_BROKEN",
      "Codex has an incomplete platform package. Reinstall it with: npm install -g @openai/codex@latest"
    );
  }
  if (signal === "SIGSEGV" || code === 139) {
    return startupAuditError(
      "PRIVACYAI_CODEX_EXECUTABLE_BROKEN",
      "Codex crashed while PrivacyAI was rendering startup input. Reinstall Codex before trying again."
    );
  }
  return startupAuditError(
    "PRIVACYAI_CODEX_CAPTURE_FAILED",
    "PrivacyAI could not verify Codex's model-visible startup input."
  );
}

function startupAuditError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
