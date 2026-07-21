import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lineageError } from "./domain.js";
import { validateLineageSchema, validateSchemaVersion } from "./schema.js";
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
    const walPresent = await regularSidecar(path + "-wal");
    const shmPresent = await regularSidecar(path + "-shm");
    if (walPresent !== shmPresent) {
      throw lineageError("PRIVACYAI_LINEAGE_BUSY", "PrivacyAI lineage storage does not have a complete read-only WAL snapshot.");
    }
    // Existing WAL+SHM files let SQLite consume live committed frames without
    // creating sidecars. A clean database uses immutable mode so a read-only
    // open cannot create WAL machinery merely because its header selects WAL.
    const source = walPresent ? path : pathToFileURL(path).href + "?immutable=1";
    database = new sqlite.DatabaseSync(source, { readOnly: true });
    validateSchemaVersion(database);
    validateLineageSchema(database);
    const repository = new SqliteLineageRepository(database, path, { readOnly: true, lineageRetryTimeoutMs: 1 });
    // Do not return the repository: its database and append members are an
    // accidental write-capable surface even when the connection is read-only.
    return Object.freeze({
      lookup: repository.lookup.bind(repository),
      lookupSession: repository.lookupSession.bind(repository),
      lookupValue: repository.lookupValue.bind(repository),
      lookupPlaceholder: repository.lookupPlaceholder.bind(repository),
      sessionTraversal: repository.sessionTraversal.bind(repository),
      valueTraversal: repository.valueTraversal.bind(repository),
      causalTraversal: repository.causalTraversal.bind(repository),
      chronological: repository.chronological.bind(repository),
      iterateChronological: repository.iterateChronological.bind(repository),
      close: repository.close.bind(repository)
    });
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

async function regularSidecar(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw lineageError("PRIVACYAI_LINEAGE_UNSAFE_PATH", "PrivacyAI lineage inspection requires regular SQLite sidecars.");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
