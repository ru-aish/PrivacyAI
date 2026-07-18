const DEFAULT_BUSY_TIMEOUT_MS = 25;
const MAX_BUSY_TIMEOUT_MS = 1000;
const DEFAULT_RETRY_TIMEOUT_MS = 2500;
const DEFAULT_RETRY_DELAY_MS = 10;
const MAX_RETRY_DELAY_MS = 100;

export function resolveContextStoreBusyTimeout(value) {
  const normalized = value == null ? DEFAULT_BUSY_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > MAX_BUSY_TIMEOUT_MS) {
    throw new TypeError(
      `verificationBusyTimeoutMs must be an integer between 0 and ${MAX_BUSY_TIMEOUT_MS}.`
    );
  }
  return normalized;
}

export async function retryContextStoreOperation(operation, options = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("Context-store retry requires an operation function.");
  }
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_RETRY_TIMEOUT_MS,
    "context-store retry timeout"
  );
  const deadline = Date.now() + timeoutMs;
  let delayMs = DEFAULT_RETRY_DELAY_MS;

  while (true) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteContentionError(error) || Date.now() >= deadline) throw error;
      await abortableDelay(
        Math.min(delayMs, Math.max(1, deadline - Date.now())),
        options.signal
      );
      delayMs = Math.min(MAX_RETRY_DELAY_MS, delayMs * 2);
    }
  }
}

function isSqliteContentionError(error) {
  let current = error;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = String(current?.code || "").toUpperCase();
    const message = String(current?.message || "").toLowerCase();
    if (
      code === "SQLITE_BUSY" ||
      code === "SQLITE_LOCKED" ||
      (code === "ERR_SQLITE_ERROR" && (
        message.includes("database is locked") ||
        message.includes("database table is locked")
      ))
    ) {
      return true;
    }
    current = current?.cause;
  }
  return false;
}

function abortableDelay(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PrivacyAI context-store retry was aborted.");
  error.name = "AbortError";
  throw error;
}

function positiveInteger(value, fallback, name) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return normalized;
}
