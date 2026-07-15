import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_VERIFIED_ITEMS = 10000;
const DEFAULT_MAX_THREAD_ITEMS = 50000;
const DEFAULT_MAX_THREADS = 10000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function openContextVerificationStore(options = {}) {
  if (options.verificationStore) return options.verificationStore;

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      return new MemoryContextVerificationStore(options);
    }
    throw error;
  }

  const path = resolve(
    options.verificationDbPath ||
    process.env.PRIVACYAI_CONTEXT_DB ||
    join(homedir(), ".local", "share", "privacyai", "context-gateway.sqlite3")
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  let database;
  try {
    database = new sqlite.DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA busy_timeout = 10000");
    initializeSchema(database);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original database error.
    }
    if (String(error?.code || "").startsWith("PRIVACYAI_CONTEXT_DB_")) throw error;
    throw contextStoreError(
      "PRIVACYAI_CONTEXT_DB_UNAVAILABLE",
      "PrivacyAI could not open its local context verification database.",
      error
    );
  }

  return new SqliteContextVerificationStore(database, path, options);
}

export function verificationFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

class SqliteContextVerificationStore {
  constructor(database, path, options = {}) {
    this.database = database;
    this.path = path;
    this.persistent = true;
    this.maxVerifiedItems = positiveInteger(
      options.maxVerifiedItems,
      DEFAULT_MAX_VERIFIED_ITEMS,
      "maxVerifiedItems"
    );
    this.maxThreadItems = positiveInteger(
      options.maxThreadItems,
      DEFAULT_MAX_THREAD_ITEMS,
      "maxThreadItems"
    );
    this.maxAgeMs = positiveInteger(options.verificationMaxAgeMs, DEFAULT_MAX_AGE_MS, "verificationMaxAgeMs");
    this.statements = prepareStatements(database);
    this.closed = false;
  }

  loadThread(sessionKey) {
    this.assertOpen();
    const row = this.statements.loadThread.get(sessionKey);
    if (!row) return emptyThread(sessionKey);
    return {
      sessionKey,
      parentSessionKeys: parseStringArray(row.parent_keys_json, "thread parent keys"),
      sessionMap: parseSessionMap(row.session_map_json, "thread session map"),
      policyFingerprint: String(row.policy_fingerprint || ""),
      updatedAt: Number(row.updated_at || 0)
    };
  }

  saveThread(sessionKey, record = {}) {
    this.assertOpen();
    const now = Date.now();
    this.statements.saveThread.run(
      sessionKey,
      JSON.stringify(normalizeStringArray(record.parentSessionKeys)),
      JSON.stringify(normalizeSessionMap(record.sessionMap)),
      String(record.policyFingerprint || ""),
      now
    );
    return { ...record, sessionKey, updatedAt: now };
  }

  getVerification(cacheKey, policyFingerprint) {
    this.assertOpen();
    const row = this.statements.getVerification.get(cacheKey, policyFingerprint);
    if (!row) return undefined;
    const now = Date.now();
    if (Number(row.last_used_at || 0) < now - this.maxAgeMs) {
      this.statements.deleteVerification.run(cacheKey);
      return undefined;
    }
    const additions = parseSessionMap(row.additions_json, "verified item additions");
    this.statements.touchVerification.run(now, cacheKey);
    return {
      cacheKey,
      contentHash: String(row.content_hash),
      artifactType: String(row.artifact_type),
      policyFingerprint: String(row.policy_fingerprint),
      sessionMapAdditions: additions
    };
  }

  putVerification(record) {
    this.assertOpen();
    const now = Date.now();
    this.statements.putVerification.run(
      record.cacheKey,
      record.contentHash,
      record.artifactType,
      record.policyFingerprint,
      JSON.stringify(normalizeSessionMap(record.sessionMapAdditions)),
      now,
      now
    );
  }

  recordThreadItem(record) {
    this.assertOpen();
    this.statements.recordThreadItem.run(
      record.sessionKey,
      record.slotKey,
      record.cacheKey,
      record.contentHash,
      record.artifactType,
      Date.now()
    );
  }

  prune() {
    this.assertOpen();
    const cutoff = Date.now() - this.maxAgeMs;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.statements.deleteOldThreadItems.run(cutoff);
      this.statements.deleteOldVerifiedItems.run(cutoff);
      this.statements.trimThreadItems.run(this.maxThreadItems);
      this.statements.trimVerifiedItems.run(this.maxVerifiedItems);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw contextStoreError(
        "PRIVACYAI_CONTEXT_DB_WRITE_FAILED",
        "PrivacyAI could not prune its local context verification database.",
        error
      );
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  assertOpen() {
    if (this.closed) {
      throw contextStoreError(
        "PRIVACYAI_CONTEXT_DB_CLOSED",
        "PrivacyAI context verification database is closed."
      );
    }
  }
}

class MemoryContextVerificationStore {
  constructor(options = {}) {
    this.persistent = false;
    this.maxVerifiedItems = positiveInteger(
      options.maxVerifiedItems,
      DEFAULT_MAX_VERIFIED_ITEMS,
      "maxVerifiedItems"
    );
    this.maxThreadItems = positiveInteger(
      options.maxThreadItems,
      DEFAULT_MAX_THREAD_ITEMS,
      "maxThreadItems"
    );
    this.maxThreads = positiveInteger(
      options.maxThreads,
      DEFAULT_MAX_THREADS,
      "maxThreads"
    );
    this.maxAgeMs = positiveInteger(
      options.verificationMaxAgeMs,
      DEFAULT_MAX_AGE_MS,
      "verificationMaxAgeMs"
    );
    this.threads = new Map();
    this.verifications = new Map();
    this.threadItems = new Map();
  }

  loadThread(sessionKey) {
    const value = this.threads.get(sessionKey);
    if (!value) return emptyThread(sessionKey);
    value.updatedAt = Date.now();
    return structuredClone(value);
  }

  saveThread(sessionKey, record = {}) {
    const value = {
      sessionKey,
      parentSessionKeys: normalizeStringArray(record.parentSessionKeys),
      sessionMap: normalizeSessionMap(record.sessionMap),
      policyFingerprint: String(record.policyFingerprint || ""),
      updatedAt: Date.now()
    };
    this.threads.set(sessionKey, structuredClone(value));
    this.prune();
    return value;
  }

  getVerification(cacheKey, policyFingerprint) {
    const value = this.verifications.get(cacheKey);
    if (!value || value.policyFingerprint !== policyFingerprint) return undefined;
    const now = Date.now();
    if (Number(value.lastUsedAt || 0) < now - this.maxAgeMs) {
      this.deleteVerification(cacheKey);
      return undefined;
    }
    value.lastUsedAt = now;
    value.hitCount = Number(value.hitCount || 0) + 1;
    return structuredClone(stripMemoryMetadata(value));
  }

  putVerification(record) {
    const now = Date.now();
    const existing = this.verifications.get(record.cacheKey);
    this.verifications.set(record.cacheKey, {
      ...structuredClone(record),
      createdAt: Number(existing?.createdAt || now),
      lastUsedAt: now,
      hitCount: Number(existing?.hitCount || 0)
    });
    this.prune();
  }

  recordThreadItem(record) {
    this.threadItems.set(`${record.sessionKey}\0${record.slotKey}`, {
      ...structuredClone(record),
      lastSeenAt: Date.now()
    });
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [key, value] of this.threadItems) {
      if (Number(value.lastSeenAt || 0) < cutoff) this.threadItems.delete(key);
    }
    for (const [cacheKey, value] of this.verifications) {
      if (Number(value.lastUsedAt || 0) < cutoff) this.deleteVerification(cacheKey);
    }
    for (const [sessionKey, value] of this.threads) {
      if (Number(value.updatedAt || 0) < cutoff) this.threads.delete(sessionKey);
    }

    trimMapByTimestamp(this.threadItems, this.maxThreadItems, "lastSeenAt");
    trimMapByTimestamp(this.verifications, this.maxVerifiedItems, "lastUsedAt", cacheKey => {
      this.deleteVerification(cacheKey);
    });
    trimMapByTimestamp(this.threads, this.maxThreads, "updatedAt");
  }

  deleteVerification(cacheKey) {
    this.verifications.delete(cacheKey);
    for (const [itemKey, item] of this.threadItems) {
      if (item.cacheKey === cacheKey) this.threadItems.delete(itemKey);
    }
  }

  close() {
    this.threads.clear();
    this.verifications.clear();
    this.threadItems.clear();
  }
}

function stripMemoryMetadata(value) {
  const { createdAt: _createdAt, lastUsedAt: _lastUsedAt, hitCount: _hitCount, ...record } = value;
  return record;
}

function trimMapByTimestamp(map, limit, field, remove = key => map.delete(key)) {
  if (map.size <= limit) return;
  const stale = [...map.entries()]
    .sort((left, right) => Number(right[1]?.[field] || 0) - Number(left[1]?.[field] || 0))
    .slice(limit);
  for (const [key] of stale) remove(key);
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS privacyai_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      session_key TEXT PRIMARY KEY,
      parent_keys_json TEXT NOT NULL,
      session_map_json TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verified_items (
      cache_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      additions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS verified_items_lru_idx
      ON verified_items(last_used_at);
    CREATE TABLE IF NOT EXISTS thread_items (
      session_key TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(session_key, slot_key),
      FOREIGN KEY(session_key) REFERENCES threads(session_key) ON DELETE CASCADE,
      FOREIGN KEY(cache_key) REFERENCES verified_items(cache_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS thread_items_seen_idx
      ON thread_items(last_seen_at);
  `);

  const current = database.prepare("SELECT value FROM privacyai_meta WHERE key = 'schema_version'").get();
  if (current && Number(current.value) !== SCHEMA_VERSION) {
    throw contextStoreError(
      "PRIVACYAI_CONTEXT_DB_SCHEMA_UNSUPPORTED",
      "PrivacyAI context verification database uses an unsupported schema version."
    );
  }
  database.prepare(`
    INSERT INTO privacyai_meta(key, value) VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(SCHEMA_VERSION));
}

function prepareStatements(database) {
  return {
    loadThread: database.prepare(`
      SELECT parent_keys_json, session_map_json, policy_fingerprint, updated_at
      FROM threads WHERE session_key = ?
    `),
    saveThread: database.prepare(`
      INSERT INTO threads(session_key, parent_keys_json, session_map_json, policy_fingerprint, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        parent_keys_json = excluded.parent_keys_json,
        session_map_json = excluded.session_map_json,
        policy_fingerprint = excluded.policy_fingerprint,
        updated_at = excluded.updated_at
    `),
    getVerification: database.prepare(`
      SELECT content_hash, artifact_type, policy_fingerprint, additions_json, last_used_at
      FROM verified_items WHERE cache_key = ? AND policy_fingerprint = ?
    `),
    deleteVerification: database.prepare("DELETE FROM verified_items WHERE cache_key = ?"),
    touchVerification: database.prepare(`
      UPDATE verified_items SET last_used_at = ?, hit_count = hit_count + 1 WHERE cache_key = ?
    `),
    putVerification: database.prepare(`
      INSERT INTO verified_items(
        cache_key, content_hash, artifact_type, policy_fingerprint,
        additions_json, created_at, last_used_at, hit_count
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(cache_key) DO UPDATE SET
        content_hash = excluded.content_hash,
        artifact_type = excluded.artifact_type,
        policy_fingerprint = excluded.policy_fingerprint,
        additions_json = excluded.additions_json,
        last_used_at = excluded.last_used_at
    `),
    recordThreadItem: database.prepare(`
      INSERT INTO thread_items(
        session_key, slot_key, cache_key, content_hash, artifact_type, last_seen_at
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key, slot_key) DO UPDATE SET
        cache_key = excluded.cache_key,
        content_hash = excluded.content_hash,
        artifact_type = excluded.artifact_type,
        last_seen_at = excluded.last_seen_at
    `),
    deleteOldThreadItems: database.prepare("DELETE FROM thread_items WHERE last_seen_at < ?"),
    deleteOldVerifiedItems: database.prepare(
      "DELETE FROM verified_items WHERE last_used_at < ?"
    ),
    trimThreadItems: database.prepare(`
      DELETE FROM thread_items WHERE rowid IN (
        SELECT rowid FROM thread_items ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?
      )
    `),
    trimVerifiedItems: database.prepare(`
      DELETE FROM verified_items WHERE cache_key IN (
        SELECT cache_key FROM verified_items
        ORDER BY last_used_at DESC LIMIT -1 OFFSET ?
      )
    `)
  };
}

function emptyThread(sessionKey) {
  return {
    sessionKey,
    parentSessionKeys: [],
    sessionMap: {},
    policyFingerprint: "",
    updatedAt: 0
  };
}

function parseSessionMap(serialized, label) {
  return normalizeSessionMap(parseJson(serialized, label));
}

function parseStringArray(serialized, label) {
  return normalizeStringArray(parseJson(serialized, label));
}

function parseJson(serialized, label) {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw contextStoreError(
      "PRIVACYAI_CONTEXT_DB_CORRUPT",
      `PrivacyAI found malformed ${label} in its local context database.`,
      error
    );
  }
}

function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    ([placeholder, original]) =>
      typeof placeholder === "string" && placeholder.length > 0 &&
      typeof original === "string" && original.length > 0 &&
      placeholder !== original
  ));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(entry => typeof entry === "string" && entry.length > 0))];
}

function positiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contextStoreError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export { MemoryContextVerificationStore, SqliteContextVerificationStore };
