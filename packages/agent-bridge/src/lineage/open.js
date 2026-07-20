import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { lineageError } from "./domain.js";
import { initializeLineageSchema } from "./schema.js";
import { SqliteLineageRepository } from "./sqlite-repository.js";
import { retryLineageContention } from "./retry.js";

// DatabaseSync is used only for atomic SQLite operations. Keep each attempt
// short; contention is retried asynchronously below so it never monopolizes
// the event loop for the whole public timeout.
const DEFAULT_BUSY_TIMEOUT_MS = 25;
const DEFAULT_RETRY_TIMEOUT_MS = 10_000;

export async function openLineageRepository(options = {}) {
  assertOptions(options);
  if (options.lineageRepository) return options.lineageRepository;

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (
      error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
      error?.code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_UNAVAILABLE",
        "PrivacyAI persistent lineage storage requires a Node.js runtime with node:sqlite."
      );
    }
    throw error;
  }

  const configuredPath = options.lineageDbPath || process.env.PRIVACYAI_LINEAGE_DB;
  const path = resolve(
    configuredPath || `${homedir()}/.local/share/privacyai/lineage.sqlite3`
  );
  const parent = dirname(path);
  const busyTimeoutMs = positiveInteger(
    options.lineageBusyTimeoutMs,
    DEFAULT_BUSY_TIMEOUT_MS,
    "lineageBusyTimeoutMs",
    100
  );
  const retryTimeoutMs = positiveInteger(
    options.lineageRetryTimeoutMs,
    DEFAULT_RETRY_TIMEOUT_MS,
    "lineageRetryTimeoutMs"
  );

  let database;
  let file;
  try {
    await ensureStorageDirectory(parent, { privateDirectory: !configuredPath });
    await inspectOptionalFile(path);
    await inspectOptionalFile(`${path}-wal`);
    await inspectOptionalFile(`${path}-shm`);

    const flags = constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0);
    file = await openFile(path, flags, 0o600);
    await file.chmod(0o600);
    const openedStat = await file.stat();
    assertSafeFile(openedStat);

    database = new sqlite.DatabaseSync(path);
    const currentStat = await lstat(path);
    if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_UNSAFE_PATH",
        "PrivacyAI lineage database path changed while it was being opened."
      );
    }
    await file.close();
    file = undefined;

    // Set busy_timeout before any operation that may contend for a lock.
    database.exec(`PRAGMA busy_timeout = ${Math.min(busyTimeoutMs, 100)}`);
    let repository;
    await retryLineageContention(() => {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA trusted_schema = OFF");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      initializeLineageSchema(database);
      // Preparing the repository statements also consults SQLite schema state
      // and can contend during a concurrent first open.
      repository = new SqliteLineageRepository(database, path, { ...options, lineageRetryTimeoutMs: retryTimeoutMs });
    }, { timeoutMs: retryTimeoutMs, signal: options.signal });

    await chmod(path, 0o600);
    await secureSidecar(`${path}-wal`);
    await secureSidecar(`${path}-shm`);

    return repository;
  } catch (error) {
    try {
      await file?.close();
    } catch {
      // The stable open failure below remains authoritative.
    }
    try {
      database?.close();
    } catch {
      // The stable open failure below remains authoritative.
    }

    if (String(error?.code || "").startsWith("PRIVACYAI_LINEAGE_")) throw error;
    if (isCorruptionError(error)) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_CORRUPT",
        "PrivacyAI lineage storage is corrupt or is not a SQLite database."
      );
    }
    if (error?.code === "ELOOP") {
      throw lineageError(
        "PRIVACYAI_LINEAGE_UNSAFE_PATH",
        "PrivacyAI lineage storage path must not use symlinks."
      );
    }
    throw lineageError(
      "PRIVACYAI_LINEAGE_UNAVAILABLE",
      "PrivacyAI could not open its local lineage storage.",
      error
    );
  }
}

async function ensureStorageDirectory(path, options) {
  await assertNoSymlinkComponents(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(path);
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_UNSAFE_PATH",
      "PrivacyAI lineage storage parent must be a real directory."
    );
  }
  assertOwnedByCurrentUser(info);

  if (options.privateDirectory) {
    await chmod(path, 0o700);
  } else if ((info.mode & 0o022) !== 0) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_UNSAFE_PATH",
      "PrivacyAI lineage storage parent must not be group- or world-writable."
    );
  }
}

async function assertNoSymlinkComponents(path) {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw lineageError(
          "PRIVACYAI_LINEAGE_UNSAFE_PATH",
          "PrivacyAI lineage storage path must not contain symlinks."
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function inspectOptionalFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_UNSAFE_PATH",
        "PrivacyAI lineage storage files must not be symlinks."
      );
    }
    assertSafeFile(info);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertSafeFile(info) {
  if (!info.isFile() || info.nlink !== 1) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_UNSAFE_PATH",
      "PrivacyAI lineage storage must use regular, unlinked files."
    );
  }
  assertOwnedByCurrentUser(info);
}

function assertOwnedByCurrentUser(info) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_UNSAFE_PATH",
      "PrivacyAI lineage storage must be owned by the current user."
    );
  }
}

async function secureSidecar(path) {
  try {
    const info = await lstat(path);
    assertSafeFile(info);
    await chmod(path, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function positiveInteger(value, fallback, name, maximum = 60_000) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_OPTIONS",
      `${name} must be a positive integer no greater than ${maximum}.`
    );
  }
  return number;
}

function assertOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_OPTIONS",
      "PrivacyAI lineage options must be an object."
    );
  }
  const allowed = new Set([
    "lineageRepository",
    "lineageDbPath",
    "lineageBusyTimeoutMs",
    "lineageRetryTimeoutMs",
    "signal",
    "clock"
  ]);
  if (Object.keys(options).some(key => !allowed.has(key))) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_OPTIONS",
      "PrivacyAI lineage options contain an unsupported field."
    );
  }
}


function isCorruptionError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("malformed") ||
    message.includes("not a database") ||
    message.includes("database disk image is malformed");
}
