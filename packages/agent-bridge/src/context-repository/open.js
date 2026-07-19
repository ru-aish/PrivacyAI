import { chmod, mkdir, open as openFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { MemoryContextVerificationStore } from "./memory-repository.js";
import { SqliteContextVerificationStore } from "./sqlite-repository.js";
import { initializeSchema } from "./schema.js";
import { resolveContextStoreBusyTimeout, retryContextStoreOperation } from "../context-store-retry.js";
import { contextStoreError } from "./errors.js";

export async function openContextVerificationStore(options = {}) {
  if (options.verificationStore) return options.verificationStore;
  let sqlite;
  try { sqlite = await import("node:sqlite"); }
  catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      return new MemoryContextVerificationStore(options);
    }
    throw error;
  }
  const configuredPath = options.verificationDbPath || process.env.PRIVACYAI_CONTEXT_DB;
  const path = resolve(configuredPath || `${homedir()}/.local/share/privacyai/context-gateway.sqlite3`);
  const busyTimeoutMs = resolveContextStoreBusyTimeout(options.verificationBusyTimeoutMs);
  let database;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (!configuredPath) await chmod(dirname(path), 0o700);
    const file = await openFile(path, "a", 0o600);
    try {
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
    database = await retryContextStoreOperation(() => {
      let candidate;
      try {
        candidate = new sqlite.DatabaseSync(path);
        candidate.exec("PRAGMA foreign_keys = ON");
        candidate.exec("PRAGMA journal_mode = WAL");
        candidate.exec("PRAGMA synchronous = FULL");
        candidate.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        initializeSchema(candidate);
        return candidate;
      } catch (error) { try { candidate?.close(); } catch {} throw error; }
    }, { timeoutMs: options.verificationRetryTimeoutMs, signal: options.signal });
    await chmod(path, 0o600);
    await chmodIfPresent(`${path}-wal`);
    await chmodIfPresent(`${path}-shm`);
    try {
      return new SqliteContextVerificationStore(database, path, options);
    } catch (error) { try { database.close(); } catch {} throw error; }
  } catch (error) {
    try { database?.close(); } catch {}
    if (String(error?.code || "").startsWith("PRIVACYAI_CONTEXT_DB_")) throw error;
    throw contextStoreError("PRIVACYAI_CONTEXT_DB_UNAVAILABLE", "PrivacyAI could not open its local context verification database.", error);
  }
}

async function chmodIfPresent(path) {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
