import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
      await createSessionLockFile(lockPath);
      return async () => rm(lockPath, { force: true });
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
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function removeStaleSessionLock(lockPath, staleMs) {
  let record;
  try {
    record = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    const age = Date.now() - Number((await stat(lockPath)).mtimeMs || 0);
    if (age <= staleMs) return false;
    await rm(lockPath, { force: true });
    return true;
  }

  const age = Date.now() - Number(record?.createdAt || 0);
  const pid = Number(record?.pid);
  if (age > staleMs || !isProcessAlive(pid)) {
    await rm(lockPath, { force: true });
    return true;
  }
  return false;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
