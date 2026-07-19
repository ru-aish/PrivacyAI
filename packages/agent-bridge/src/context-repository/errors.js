export function contextStoreError(code, message, cause) {
  const safeCause = sqliteContentionCause(cause);
  const error = new Error(message, safeCause ? { cause: safeCause } : undefined);
  error.code = code;
  return error;
}

export function closedError() {
  return contextStoreError(
    "PRIVACYAI_CONTEXT_DB_CLOSED",
    "PrivacyAI context verification database is closed."
  );
}

export function collisionError() {
  return contextStoreError(
    "PRIVACYAI_SESSION_MAP_COLLISION",
    "PrivacyAI blocked an ambiguous session-map merge."
  );
}

export function writeError(action, cause) {
  return contextStoreError(
    "PRIVACYAI_CONTEXT_DB_WRITE_FAILED",
    `PrivacyAI could not ${action} in its local cache ledger.`,
    cause
  );
}

export function timeoutError() {
  return contextStoreError(
    "PRIVACYAI_CONTEXT_DB_RETRY_TIMEOUT",
    "PrivacyAI context database retry timed out."
  );
}

function sqliteContentionCause(cause) {
  let current = cause;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = String(current?.code || "").toUpperCase();
    const message = String(current?.message || "").toLowerCase();
    if (
      code === "SQLITE_BUSY" ||
      code === "SQLITE_LOCKED" ||
      (code === "ERR_SQLITE_ERROR" && message.includes("locked"))
    ) {
      const safe = new Error("SQLite contention prevented the local context operation.");
      safe.code = code === "SQLITE_LOCKED" ? "SQLITE_LOCKED" : "SQLITE_BUSY";
      return safe;
    }
    current = current?.cause;
  }
  return undefined;
}
