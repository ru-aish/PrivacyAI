import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { CONTEXT_SCHEMA_VERSION } from "./context-repository/constants.js";

const DEFAULT_DATABASE_PATH = `${homedir()}/.local/share/privacyai/context-gateway.sqlite3`;
const REQUIRED_TABLES = Object.freeze([
  "privacyai_meta",
  "threads",
  "verified_items",
  "thread_items",
  "ledger_worktrees",
  "ledger_manifests",
  "ledger_file_mutations"
]);

export async function createCliInspectionService(options = {}) {
  const path = resolve(
    options.verificationDbPath || process.env.PRIVACYAI_CONTEXT_DB || DEFAULT_DATABASE_PATH
  );

  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw inspectionError(
        "PRIVACYAI_INSPECTION_UNAVAILABLE",
        "PrivacyAI local state is not initialized; nothing to inspect."
      );
    }
    throw inspectionError(
      "PRIVACYAI_INSPECTION_UNAVAILABLE",
      "PrivacyAI could not read its local state."
    );
  }

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      throw inspectionError(
        "PRIVACYAI_INSPECTION_UNAVAILABLE",
        "This Node.js runtime does not support read-only PrivacyAI state inspection."
      );
    }
    throw error;
  }

  let database;
  try {
    database = new sqlite.DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    const schemaVersion = validateSchema(database);
    return createDatabaseService(database, schemaVersion);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original inspection failure.
    }
    if (String(error?.code || "").startsWith("PRIVACYAI_INSPECTION_")) throw error;
    throw inspectionError(
      "PRIVACYAI_INSPECTION_UNAVAILABLE",
      "PrivacyAI local state is unreadable or incompatible."
    );
  }
}

export function createRepositoryInspectionService(store) {
  if (!store?.database) {
    throw new TypeError("Repository inspection requires a SQLite-backed store.");
  }
  return createDatabaseService(store.database, CONTEXT_SCHEMA_VERSION, false);
}

function createDatabaseService(database, schemaVersion, ownsDatabase = true) {
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw inspectionError(
        "PRIVACYAI_INSPECTION_CLOSED",
        "PrivacyAI inspection service is closed."
      );
    }
  };

  return Object.freeze({
    inspectCache(request = {}) {
      assertOpen();
      return inspectCache(database, schemaVersion, request);
    },
    inspectLineage(request = {}) {
      assertOpen();
      return inspectLineage(database, schemaVersion, request);
    },
    close() {
      if (closed) return;
      closed = true;
      if (ownsDatabase) database.close();
    }
  });
}

export function inspectCache(database, schemaVersion, request = {}) {
  const action = request.action || "summary";
  if (action === "summary") {
    const summary = database.prepare(`
      SELECT COUNT(*) AS entry_count,
             COALESCE(SUM(hit_count), 0) AS hit_count,
             MIN(created_at) AS oldest_created_at,
             MAX(last_used_at) AS newest_used_at
      FROM verified_items
    `).get();
    const artifacts = database.prepare(`
      SELECT artifact_type,
             COUNT(*) AS entry_count,
             COALESCE(SUM(hit_count), 0) AS hit_count
      FROM verified_items
      GROUP BY artifact_type
      ORDER BY entry_count DESC, artifact_type ASC
    `).all();
    return {
      schemaVersion,
      summary: normalizeNumbers(summary),
      artifacts: artifacts.map(normalizeNumbers)
    };
  }

  if (action === "list") {
    const entries = database.prepare(`
      SELECT cache_key, content_hash, artifact_type, policy_fingerprint,
             created_at, last_used_at, hit_count
      FROM verified_items
      ORDER BY last_used_at DESC, cache_key ASC
      LIMIT ?
    `).all(normalizeLimit(request.limit));
    return { schemaVersion, entries: entries.map(normalizeNumbers) };
  }

  if (action === "show") {
    const row = database.prepare(`
      SELECT cache_key, content_hash, artifact_type, policy_fingerprint,
             additions_json, created_at, last_used_at, hit_count
      FROM verified_items
      WHERE cache_key = ?
    `).get(String(request.key || ""));
    if (!row) return { schemaVersion, entry: null };
    const { additions_json: additionsJson, ...metadata } = row;
    return {
      schemaVersion,
      entry: {
        ...normalizeNumbers(metadata),
        additionCount: jsonObjectKeyCount(additionsJson)
      }
    };
  }

  throw new TypeError(`Unsupported cache inspection action: ${action}`);
}

export function inspectLineage(database, schemaVersion, request = {}) {
  const action = request.action || "summary";
  if (action === "summary") {
    const counts = {
      sessions: scalarCount(database, "threads"),
      sessionItems: scalarCount(database, "thread_items"),
      worktrees: scalarCount(database, "ledger_worktrees"),
      manifests: scalarCount(database, "ledger_manifests"),
      mutations: scalarCount(database, "ledger_file_mutations")
    };
    const mutationStatuses = database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM ledger_file_mutations
      GROUP BY status
      ORDER BY status ASC
    `).all().map(normalizeNumbers);
    return { schemaVersion, summary: counts, mutationStatuses };
  }

  if (action === "list") {
    const rows = database.prepare(`
      SELECT session_key, parent_keys_json, session_map_json,
             policy_fingerprint, updated_at
      FROM threads
      ORDER BY updated_at DESC, session_key ASC
      LIMIT ?
    `).all(normalizeLimit(request.limit));
    return { schemaVersion, sessions: rows.map(threadMetadata) };
  }

  if (action === "show") {
    const row = database.prepare(`
      SELECT session_key, parent_keys_json, session_map_json,
             policy_fingerprint, updated_at
      FROM threads
      WHERE session_key = ?
    `).get(String(request.key || ""));
    if (!row) return { schemaVersion, session: null };
    const items = database.prepare(`
      SELECT slot_key, cache_key, content_hash, artifact_type, last_seen_at
      FROM thread_items
      WHERE session_key = ?
      ORDER BY last_seen_at DESC, slot_key ASC
      LIMIT ?
    `).all(row.session_key, normalizeLimit(request.limit));
    return {
      schemaVersion,
      session: {
        ...threadMetadata(row),
        items: items.map(normalizeNumbers)
      }
    };
  }

  if (action === "mutations") {
    const geometryColumns = schemaVersion >= 3
      ? "operation_type, source_length, next_length,"
      : "'unknown' AS operation_type, NULL AS source_length, NULL AS next_length,";
    const mutations = database.prepare(`
      SELECT mutation_id, worktree_id, path_hash, expected_content_hash,
             next_content_hash, manifest_hash, status, opaque_reference,
             ${geometryColumns}
             committed_reference, created_at, last_used_at
      FROM ledger_file_mutations
      ORDER BY last_used_at DESC, mutation_id ASC
      LIMIT ?
    `).all(normalizeLimit(request.limit));
    return { schemaVersion, mutations: mutations.map(normalizeNumbers) };
  }

  throw new TypeError(`Unsupported lineage inspection action: ${action}`);
}

function validateSchema(database) {
  const existingTables = new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(row => String(row.name))
  );
  for (const table of REQUIRED_TABLES) {
    if (!existingTables.has(table)) {
      throw inspectionError(
        "PRIVACYAI_INSPECTION_SCHEMA_UNSUPPORTED",
        "PrivacyAI local state does not contain the required inspection schema."
      );
    }
  }

  const meta = database.prepare(
    "SELECT value FROM privacyai_meta WHERE key = 'schema_version'"
  ).get();
  const schemaVersion = Number(meta?.value);
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > CONTEXT_SCHEMA_VERSION
  ) {
    throw inspectionError(
      "PRIVACYAI_INSPECTION_SCHEMA_UNSUPPORTED",
      "PrivacyAI local state uses an unsupported schema version."
    );
  }
  return schemaVersion;
}

function threadMetadata(row) {
  const parents = parseJsonArray(row.parent_keys_json);
  return {
    session_key: String(row.session_key),
    parent_session_keys: parents.map(value => String(value)),
    mapping_count: jsonObjectKeyCount(row.session_map_json),
    policy_fingerprint: String(row.policy_fingerprint || ""),
    updated_at: Number(row.updated_at || 0)
  };
}

function scalarCount(database, table) {
  if (!REQUIRED_TABLES.includes(table)) {
    throw new TypeError("Unsupported inspection count table.");
  }
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0);
}

function normalizeLimit(value) {
  const parsed = value == null ? 10 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new TypeError("Inspection limit must be an integer between 1 and 100.");
  }
  return parsed;
}

function normalizeNumbers(row) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value
    ])
  );
}

function parseJsonArray(value) {
  return parseStoredJson(value, Array.isArray);
}

function jsonObjectKeyCount(value) {
  const parsed = parseStoredJson(
    value,
    item => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
  return Object.keys(parsed).length;
}

function parseStoredJson(value, isExpectedShape) {
  try {
    const parsed = JSON.parse(String(value));
    if (!isExpectedShape(parsed)) throw new TypeError("Unexpected stored JSON shape.");
    return parsed;
  } catch {
    throw inspectionError(
      "PRIVACYAI_INSPECTION_CORRUPT",
      "PrivacyAI local state contains invalid inspection metadata."
    );
  }
}

function inspectionError(code, message) {
  return Object.assign(new Error(message), { code });
}
