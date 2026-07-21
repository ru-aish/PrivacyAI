import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeSessionMap } from "@privacy-ai/sdk";

import { isSameLiveProcess, readProcessStartIdentity } from "./process-identity.js";
import {
  identityDomainForAlias,
  loadInstallationPrivacyIdentity,
  sessionPrivacyIdentity
} from "./privacy-identity.js";

const VAULT_VERSION = 2;
const VAULT_LOCATOR_VERSION = 1;
const VAULT_LOCATOR_KIND = "privacyai-vault-locator";

export class SessionVault {
  constructor(options = {}) {
    this.baseDir = resolve(
      options.baseDir ||
      process.env.PRIVACYAI_AGENT_VAULT_DIR ||
      join(homedir(), ".local", "share", "privacyai", "agent-sessions")
    );
    this.identityRoot = options.identityRoot;
  }

  pathForSession(sessionId) {
    requireSessionId(sessionId);
    if (this.identityRoot?.digest) {
      const digest = this.identityRoot.digest("vault-path", {
        version: VAULT_VERSION,
        sessionId
      });
      return join(this.baseDir, `v${VAULT_VERSION}-${digest}.json`);
    }
    return this.legacyPathForSession(sessionId);
  }

  legacyPathForSession(sessionId) {
    requireSessionId(sessionId);
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.baseDir, `${digest}.json`);
  }

  async load(sessionId) {
    let path = this.pathForSession(sessionId);
    const legacyPath = this.legacyPathForSession(sessionId);
    await ensurePrivateDirectory(this.baseDir);
    let serialized;
    let sourcePath = path;
    try {
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (path !== legacyPath) {
        try {
          serialized = await readFile(legacyPath, "utf8");
          sourcePath = legacyPath;
        } catch (legacyError) {
          if (legacyError?.code !== "ENOENT") throw legacyError;
        }
      }
      if (serialized == null && !this.identityRoot) {
        try {
          this.identityRoot = await loadInstallationPrivacyIdentity({ baseDir: this.baseDir });
          path = this.pathForSession(sessionId);
          if (path !== legacyPath) {
            serialized = await readFile(path, "utf8");
            sourcePath = path;
          }
        } catch (identityError) {
          if (identityError?.code !== "ENOENT") throw identityError;
        }
      }
      if (serialized == null) {
        const identity = this.identityRoot
          ? sessionPrivacyIdentity(this.identityRoot, sessionId)
          : null;
        return {
          version: VAULT_VERSION,
          sessionId,
          sessionMap: {},
          identityMap: {},
          identityKeyId: identity?.keyId || null,
          identityScope: identity?.scope || null,
          updatedAt: null,
          path
        };
      }
    }
    try {
      const located = await resolveVaultLocator(serialized, sourcePath, this.baseDir);
      if (located) {
        serialized = located.serialized;
        sourcePath = located.path;
      }
    } catch {
      throw corruptVaultError();
    }
    try {
      const parsed = parseStoredObject(serialized);
      const version = parsed.version == null ? 1 : Number(parsed.version);
      if (version !== 1 && version !== VAULT_VERSION) {
        throw new TypeError("stored session data uses an unsupported version");
      }
      const sessionMap = normalizeSessionMap(parsed.sessionMap);
      const identity = this.identityRoot
        ? sessionPrivacyIdentity(this.identityRoot, sessionId)
        : null;
      const identityMap = identity
        ? describeSessionMap(identity, sessionMap)
        : normalizeStoredIdentityMap(parsed.identityMap);
      if (
        identity &&
        parsed.identityKeyId === identity.keyId &&
        parsed.identityMap != null
      ) {
        assertStoredIdentityMap(identity, parsed.identityMap, identityMap);
      }
      return {
        version,
        sessionId,
        sessionMap,
        identityMap,
        identityKeyId: identity?.keyId || parsed.identityKeyId || null,
        identityScope: identity?.scope || parsed.identityScope || null,
        updatedAt: parsed.updatedAt || null,
        path,
        ...(sourcePath !== path ? { legacyPath: sourcePath } : {})
      };
    } catch (error) {
      if (error?.code === "PRIVACYAI_IDENTITY_COLLISION") throw error;
      throw corruptVaultError();
    }
  }

  async save(sessionId, sessionMap) {
    const path = this.pathForSession(sessionId);
    const legacyPath = this.legacyPathForSession(sessionId);
    await ensurePrivateDirectory(this.baseDir);

    const normalizedMap = normalizeSessionMap(sessionMap);
    const identity = this.identityRoot
      ? sessionPrivacyIdentity(this.identityRoot, sessionId)
      : null;
    const record = {
      version: VAULT_VERSION,
      sessionId,
      sessionMap: normalizedMap,
      identityMap: identity ? describeSessionMap(identity, normalizedMap) : {},
      identityKeyId: identity?.keyId || null,
      identityScope: identity?.scope || null,
      updatedAt: new Date().toISOString()
    };
    const previousTarget = legacyPath === path
      ? null
      : await readVaultLocatorTarget(legacyPath, this.baseDir);
    await writePrivateJsonAtomic(path, record);
    if (legacyPath !== path) {
      await writePrivateJsonAtomic(legacyPath, {
        version: VAULT_LOCATOR_VERSION,
        kind: VAULT_LOCATOR_KIND,
        file: basename(path),
        updatedAt: record.updatedAt
      });
      if (previousTarget && previousTarget !== path) {
        await rm(previousTarget, { force: true });
      }
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

    const release = await acquireSessionLock(
      this.legacyPathForSession(sessionId) + ".lock",
      options
    );
    try {
      throwIfVaultAborted(options.signal);
      const current = await this.load(sessionId);
      if (current.version < VAULT_VERSION) throw vaultMigrationRequiredError();
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
    try {
      const parsed = parseStoredObject(serialized);
      return normalizeSessionMap(parsed.sessionMap || parsed);
    } catch {
      const error = new Error("PrivacyAI found malformed data in its local session map file.");
      error.code = "PRIVACYAI_SESSION_MAP_FILE_CORRUPT";
      throw error;
    }
  }

  const sessionId = options.sessionId;
  if (!sessionId) return {};
  const vault = options.vault || new SessionVault(options);
  return (await vault.load(sessionId)).sessionMap;
}

async function resolveVaultLocator(serialized, sourcePath, baseDir) {
  const file = parseVaultLocatorFile(serialized);
  if (!file) return null;
  const path = join(baseDir, file);
  if (path === sourcePath) throw new TypeError("vault locator cycle");
  return { path, serialized: await readFile(path, "utf8") };
}

async function readVaultLocatorTarget(path, baseDir) {
  let serialized;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const file = parseVaultLocatorFile(serialized);
  return file ? join(baseDir, file) : null;
}

function parseVaultLocatorFile(serialized) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind !== VAULT_LOCATOR_KIND) return null;
  if (
    value.version !== VAULT_LOCATOR_VERSION ||
    typeof value.file !== "string" ||
    basename(value.file) !== value.file ||
    !/^v2-[a-f0-9]{64}\.json$/.test(value.file)
  ) {
    throw new TypeError("vault locator is malformed");
  }
  return value.file;
}

async function writePrivateJsonAtomic(path, value) {
  const tempPath = path + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function describeSessionMap(identity, sessionMap) {
  return identity.describeSessionMap(sessionMap, {
    domainForAlias: alias => identityDomainForAlias(alias)
  });
}

function normalizeStoredIdentityMap(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("stored identity metadata must be an object");
  }
  const output = {};
  for (const [alias, record] of Object.entries(value)) {
    if (
      typeof alias !== "string" ||
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof record.id !== "string" ||
      typeof record.protectedValueId !== "string" ||
      typeof record.keyId !== "string" ||
      typeof record.category !== "string" ||
      typeof record.domain !== "string"
    ) {
      throw new TypeError("stored identity metadata is malformed");
    }
    output[alias] = {
      version: Number(record.version || 1),
      id: record.id,
      alias,
      category: record.category,
      domain: record.domain,
      keyId: record.keyId,
      scope: record.scope || null,
      protectedValueId: record.protectedValueId
    };
  }
  return output;
}

function assertStoredIdentityMap(identity, stored, expected) {
  const normalized = normalizeStoredIdentityMap(stored);
  const aliases = Object.keys(expected);
  if (Object.keys(normalized).length !== aliases.length) throw new TypeError("identity metadata mismatch");
  for (const alias of aliases) {
    const left = normalized[alias];
    const right = expected[alias];
    if (
      !left ||
      !identity.equal(left.id, right.id) ||
      !identity.equal(left.protectedValueId, right.protectedValueId) ||
      !identity.equal(left.keyId, right.keyId) ||
      left.category !== right.category ||
      left.domain !== right.domain ||
      JSON.stringify(left.scope) !== JSON.stringify(right.scope)
    ) {
      throw new TypeError("identity metadata mismatch");
    }
  }
}

function requireSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new TypeError("SessionVault requires a non-empty session id.");
  }
}

function parseStoredObject(serialized) {
  const value = JSON.parse(serialized);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("stored session data must be an object");
  }
  return value;
}

function corruptVaultError() {
  const error = new Error("PrivacyAI found malformed data in its local session vault.");
  error.code = "PRIVACYAI_VAULT_CORRUPT";
  return error;
}

function vaultMigrationRequiredError() {
  const error = new Error(
    "PrivacyAI session state requires explicit migration. Run `privacyai state migrate --backup <directory>` before continuing."
  );
  error.code = "PRIVACYAI_VAULT_MIGRATION_REQUIRED";
  return error;
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
