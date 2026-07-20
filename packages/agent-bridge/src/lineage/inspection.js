import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { lineageError } from "./domain.js";
import { validateLineageSchema } from "./schema.js";
import { SqliteLineageRepository } from "./sqlite-repository.js";

/**
 * Opens an existing lineage database for inspection only. This path deliberately
 * performs no mkdir/chmod/pragma/schema work: SQLite is opened read-only and
 * missing or invalid state is reported without repairing it.
 */
export async function openLineageInspection(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => !new Set(["lineageDbPath"]).has(key))) {
    throw lineageError("PRIVACYAI_LINEAGE_INVALID_OPTIONS", "PrivacyAI lineage inspection options are invalid.");
  }
  if (typeof options.lineageDbPath !== "string" || !options.lineageDbPath) {
    throw lineageError("PRIVACYAI_LINEAGE_INVALID_OPTIONS", "PrivacyAI lineage inspection requires lineageDbPath.");
  }
  const path = resolve(options.lineageDbPath);
  let database;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw lineageError("PRIVACYAI_LINEAGE_UNSAFE_PATH", "PrivacyAI lineage inspection requires a regular database file.");
    }
    const sqlite = await import("node:sqlite");
    // immutable=1 prevents SQLite's WAL read machinery from creating -wal/-shm
    // sidecars. Inspection is intentionally a snapshot, never a live repair.
    database = new sqlite.DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
    validateLineageSchema(database);
    return new SqliteLineageRepository(database, path, { lineageRetryTimeoutMs: 1 });
  } catch (error) {
    try { database?.close(); } catch {}
    if (String(error?.code || "").startsWith("PRIVACYAI_LINEAGE_")) throw error;
    if (error?.code === "ENOENT") {
      throw lineageError("PRIVACYAI_LINEAGE_NOT_FOUND", "PrivacyAI lineage storage does not exist.");
    }
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("malformed") || message.includes("not a database")) {
      throw lineageError("PRIVACYAI_LINEAGE_CORRUPT", "PrivacyAI lineage storage is corrupt or is not a SQLite database.");
    }
    throw lineageError("PRIVACYAI_LINEAGE_SCHEMA_INVALID", "PrivacyAI lineage storage is incompatible with this PrivacyAI release.");
  }
}
