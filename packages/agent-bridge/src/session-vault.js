import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeSessionMap } from "@privacy-ai/sdk";

import { isSameLiveProcess, readProcessStartIdentity } from "./process-identity.js";

const VAULT_VERSION = 1;

export class SessionVault {
  constructor(options = {}) {
    this.baseDir = resolve(
      options.baseDir ||
      process.env.PRIVACYAI_AGENT_VAULT_DIR ||
      join(homedir(), ".local", "share", "privacyai", "agent-sessions")
    );
  }

  pathForSession(sessionId) {
    if (!sessionId || typeof sessionId !== "string") {
      throw new TypeError("SessionVault requires a non-empty session id.");
    }
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.baseDir, `${digest}.json`);
  }

  async load(sessionId) {
    const path = this.pathForSession(sessionId);
    await ensurePrivateDirectory(this.baseDir);
    let serialized;
    try {
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return {
        version: VAULT_VERSION,
        sessionId,
        sessionMap: {},
        updatedAt: null,
        path
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      const error = new Error("PrivacyAI found malformed data in its local session vault.");
      error.code = "PRIVACYAI_VAULT_CORRUPT";
      throw error;
    }
    return {
      version: parsed.version || VAULT_VERSION,
      sessionId,
      sessionMap: normalizeSessionMap(parsed.sessionMap),
      updatedAt: parsed.updatedAt || null,
      path
    };
  }

  async save(sessionId, sessionMap) {
    const path = this.pathForSession(sessionId);
    await ensurePrivateDirectory(this.baseDir);

    const record = {
      version: VAULT_VERSION,
      sessionId,
      sessionMap: normalizeSessionMap(sessionMap),
      updatedAt: new Date().toISOString()
    };
    const tempPath = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, path);
      await chmod(path, 0o600);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    return { ...record, path };
  }

  async merge(sessionId, additions, options = {}) {
    return this.update(
      sessionId,
      current => mergeVaultSessionMaps(current.sessionMap, additions),
      options
    );
  }

  async update(sessionId, updater, options = {}) {
    if (typeof updater !== "function") {
      throw new TypeError("SessionVault.update requires an updater function.");
    }

    const release = await acquireSessionLock(`${this.pathForSession(sessionId)}.lock`, options);
    try {
      throwIfVaultAborted(options.signal);
      const current = await this.load(sessionId);
      throwIfVaultAborted(options.signal);
      const nextMap = await updater(current);
      throwIfVaultAborted(options.signal);
      return await this.save(sessionId, nextMap);
    } finally {
      await release();
    }
  }
}

export async function loadSessionMap(options = {}) {
  if (options.mapFile || process.env.PRIVACYAI_SESSION_MAP_FILE) {
    const path = resolve(options.mapFile || process.env.PRIVACYAI_SESSION_MAP_FILE);
    const serialized = await readFile(path, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      const error = new Error("PrivacyAI found malformed data in its local session map file.");
      error.code = "PRIVACYAI_SESSION_MAP_FILE_CORRUPT";
      throw error;
    }
    return normalizeSessionMap(parsed.sessionMap || parsed);
  }

  const sessionId = options.sessionId;
  if (!sessionId) return {};
  const vault = options.vault || new SessionVault(options);
  return (await vault.load(sessionId)).sessionMap;
}

async function acquireSessionLock(lockPath, options = {}) {
  throwIfVaultAborted(options.signal);
  const timeoutMs = positiveOption(options.lockTimeoutMs, 10000, "lockTimeoutMs");
  const retryMs = positiveOption(options.lockRetryMs, 25, "lockRetryMs");
  const staleMs = positiveOption(options.staleLockMs, 30000, "staleLockMs");
  const started = Date.now();
  await ensurePrivateDirectory(dirname(lockPath));

  while (true) {
    try {
      const owner = await createSessionLockFile(lockPath);
      return async () => {
        await removeLockIfUnchanged(lockPath, owner);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleSessionLock(lockPath, staleMs)) continue;
      if (Date.now() - started >= timeoutMs) {
        const lockError = new Error("Timed out waiting for the PrivacyAI session vault lock.");
        lockError.code = "PRIVACYAI_VAULT_LOCK_TIMEOUT";
        throw lockError;
      }
      await abortableVaultDelay(retryMs, options.signal);
    }
  }
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function mergeVaultSessionMaps(current, additions) {
  const merged = normalizeSessionMap(current);
  for (const [placeholder, original] of Object.entries(normalizeSessionMap(additions))) {
    if (Object.hasOwn(merged, placeholder) && merged[placeholder] !== original) {
      const error = new Error("PrivacyAI blocked an ambiguous placeholder mapping.");
      error.code = "PRIVACYAI_SESSION_MAP_COLLISION";
      throw error;
    }
    merged[placeholder] = original;
  }
  return normalizeSessionMap(merged);
}

function positiveOption(value, fallback, name) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  return normalized;
}

function abortableVaultDelay(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); error ? rejectPromise(error) : resolvePromise(); };
    const onAbort = () => { const error = signal?.reason instanceof Error ? signal.reason : Object.assign(new Error("PrivacyAI session vault lock wait was aborted."), { name: "AbortError" }); finish(error); };
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function throwIfVaultAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : Object.assign(new Error("PrivacyAI session vault lock wait was aborted."), { name: "AbortError" });
  throw error;
}

async function createSessionLockFile(lockPath) {
  const owner = `${JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token: randomUUID(),
    processStart: await readProcessStartIdentity(process.pid)
  })}\n`;
  await writeFile(lockPath, owner, { flag: "wx", mode: 0o600 });
  return owner;
}

async function removeStaleSessionLock(lockPath, staleMs) {
  let serialized;
  let record;
  try {
    serialized = await readFile(lockPath, "utf8");
    record = JSON.parse(serialized);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    let metadata;
    try {
      metadata = await stat(lockPath);
    } catch (statError) {
      if (statError?.code === "ENOENT") return true;
      throw statError;
    }
    if (Date.now() - Number(metadata.mtimeMs || 0) <= staleMs) return false;
    return removeLockIfUnchanged(lockPath, serialized || "");
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
