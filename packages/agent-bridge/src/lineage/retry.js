import { lineageError } from "./domain.js";

export async function retryLineageContention(action, {
  timeoutMs,
  signal,
  now = Date.now,
  initialContention
}) {
  const deadline = now() + timeoutMs;
  let delay = 2;
  let contention = initialContention;
  while (true) {
    throwIfAborted(signal);
    if (contention) {
      if (!isSqliteContention(contention)) throw contention;
      if (now() >= deadline) {
        throw lineageError("PRIVACYAI_LINEAGE_BUSY", "PrivacyAI lineage storage remained busy.", sanitizedContentionCause(contention));
      }
      await delayWithAbort(Math.min(delay, Math.max(1, deadline - now())), signal);
      delay = Math.min(delay * 2, 50);
      contention = undefined;
    }
    try {
      return action();
    } catch (error) {
      if (!isSqliteContention(error)) throw error;
      contention = error;
    }
  }
}

export function isSqliteContention(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    const code = String(current.code || "");
    const message = String(current.message || "").toLowerCase();
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ||
        (code === "ERR_SQLITE_ERROR" && /(?:database|table).*locked|busy/.test(message)) ||
        /(?:database|table) is locked|database is busy/.test(message)) return true;
  }
  return false;
}

export function sanitizedContentionCause(_error) {
  const cause = new Error("SQLite reported local lineage contention.");
  cause.code = sqliteContentionCode(_error);
  return cause;
}

function sqliteContentionCode(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.code === "SQLITE_LOCKED" || /table.*locked/i.test(String(current.message || ""))) return "SQLITE_LOCKED";
    if (current.code === "SQLITE_BUSY" || /(?:database.*busy|database.*locked)/i.test(String(current.message || ""))) return "SQLITE_BUSY";
  }
  return "SQLITE_BUSY";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw lineageError("PRIVACYAI_LINEAGE_ABORTED", "PrivacyAI lineage operation was cancelled.");
}

function delayWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      callback(value);
    };
    let timer;
    const aborted = () => finish(reject)(lineageError("PRIVACYAI_LINEAGE_ABORTED", "PrivacyAI lineage operation was cancelled."));
    if (signal?.aborted) return aborted();
    if (signal) signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(finish(resolve), ms);
  });
}
