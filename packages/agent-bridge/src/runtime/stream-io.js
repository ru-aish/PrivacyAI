import { resolvePositiveDuration } from "./duration.js";

export function destroyStream(stream, error) {
  if (!stream || stream.destroyed) return;
  if (!error) {
    stream.destroy();
    return;
  }

  const ignoreExpectedError = () => {};
  const cleanup = () => stream.off("error", ignoreExpectedError);
  stream.once("error", ignoreExpectedError);
  stream.once("close", cleanup);
  stream.destroy(error);
}

export function writeWithBackpressure(stream, value, closedError) {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.reject(materializeError(closedError, "HTTP response stream closed."));
  }

  let accepted;
  try {
    accepted = stream.write(value);
  } catch (error) {
    return Promise.reject(error);
  }
  if (accepted) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(materializeError(closedError, "HTTP response stream closed."));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

export function nextWithTimeout(iterator, stream, timeoutMs, timeoutError, label = "stream idle timeout") {
  const idleTimeoutMs = resolvePositiveDuration(timeoutMs, timeoutMs, label);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = materializeError(timeoutError, "HTTP stream timed out.");
      destroyStream(stream, error);
      reject(error);
    }, idleTimeoutMs);

    Promise.resolve(iterator.next()).then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function materializeError(value, fallbackMessage) {
  const error = typeof value === "function" ? value() : value;
  return error instanceof Error ? error : new Error(fallbackMessage);
}
