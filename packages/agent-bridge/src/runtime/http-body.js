import { resolvePositiveDuration } from "./duration.js";
import { destroyStream } from "./stream-io.js";

export function readBoundedHttpBody(stream, maxBytes, options = {}) {
  const chunks = [];
  const idleTimeoutMs = options.idleTimeoutMs == null
    ? null
    : resolvePositiveDuration(
      options.idleTimeoutMs,
      options.idleTimeoutMs,
      options.idleTimeoutLabel || "HTTP body idle timeout"
    );
  let size = 0;
  let settled = false;
  let ended = false;
  let idleTimer = null;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (options.errors?.aborted) stream.off("aborted", onAborted);
      stream.off("close", onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const resetIdleTimer = () => {
      if (idleTimeoutMs == null || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = materializeError(options.errors?.idle, "HTTP body timed out.");
        finish(error);
        destroyStream(stream, error);
      }, idleTimeoutMs);
    };
    const onData = chunk => {
      if (settled) return;
      resetIdleTimer();
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > maxBytes) {
        finish(materializeError(options.errors?.tooLarge, "HTTP body exceeded its size limit."));
        if (options.limitAction === "drain" && typeof stream.resume === "function") stream.resume();
        else destroyStream(stream);
        return;
      }
      chunks.push(value);
    };
    const onEnd = () => {
      ended = true;
      finish(null, Buffer.concat(chunks, size));
    };
    const onError = error => finish(error);
    const onAborted = () => finish(materializeError(options.errors?.aborted, "HTTP body was aborted."));
    const onClose = () => {
      if (ended || settled) return;
      finish(materializeError(options.errors?.truncated, "HTTP body closed before completion."));
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    if (options.errors?.aborted) stream.once("aborted", onAborted);
    stream.once("close", onClose);
    resetIdleTimer();
  });
}

function materializeError(value, fallbackMessage) {
  const error = typeof value === "function" ? value() : value;
  return error instanceof Error ? error : new Error(fallbackMessage);
}
