import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      return {
        version: parsed.version || VAULT_VERSION,
        sessionId,
        sessionMap: normalizeSessionMap(parsed.sessionMap),
        updatedAt: parsed.updatedAt || null,
        path
      };
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
  }

  async save(sessionId, sessionMap) {
    const path = this.pathForSession(sessionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    const record = {
      version: VAULT_VERSION,
      sessionId,
      sessionMap: normalizeSessionMap(sessionMap),
      updatedAt: new Date().toISOString()
    };
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
    return { ...record, path };
  }

  async merge(sessionId, additions, options = {}) {
    return this.update(
      sessionId,
      current => ({
        ...current.sessionMap,
        ...normalizeSessionMap(additions)
      }),
      options
    );
  }

  async update(sessionId, updater, options = {}) {
    if (typeof updater !== "function") {
      throw new TypeError("SessionVault.update requires an updater function.");
    }

    const release = await acquireSessionLock(`${this.pathForSession(sessionId)}.lock`, options);
    try {
      const current = await this.load(sessionId);
      const nextMap = await updater(current);
      return await this.save(sessionId, nextMap);
    } finally {
      await release();
    }
  }
}

export async function loadSessionMap(options = {}) {
  if (options.mapFile || process.env.PRIVACYAI_SESSION_MAP_FILE) {
    const path = resolve(options.mapFile || process.env.PRIVACYAI_SESSION_MAP_FILE);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return normalizeSessionMap(parsed.sessionMap || parsed);
  }

  const sessionId = options.sessionId;
  if (!sessionId) return {};
  const vault = options.vault || new SessionVault(options);
  return (await vault.load(sessionId)).sessionMap;
}

function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([dummy, original]) =>
        typeof dummy === "string" &&
        typeof original === "string" &&
        dummy.length > 0 &&
        original.length > 0 &&
        dummy !== original
    )
  );
}

async function acquireSessionLock(lockPath, options = {}) {
  const timeoutMs = Number(options.lockTimeoutMs || 10000);
  const retryMs = Number(options.lockRetryMs || 25);
  const staleMs = Number(options.staleLockMs || 30000);
  const started = Date.now();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

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
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
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
