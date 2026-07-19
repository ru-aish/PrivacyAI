export function createDownstreamLifecycle(request, response, disconnectError) {
  const controller = new AbortController();
  let disconnected = false;

  const abort = () => {
    if (controller.signal.aborted || response.writableEnded) return;
    disconnected = true;
    controller.abort(materializeError(disconnectError));
  };

  request.once("aborted", abort);
  response.once("close", abort);

  return {
    signal: controller.signal,
    disconnected: () => disconnected,
    downstreamClosed: () => disconnected,
    cleanup() {
      request.off("aborted", abort);
      response.off("close", abort);
    }
  };
}

export function bindAbortSignal(stream, signal) {
  if (!signal) return () => {};

  const abort = () => {
    if (!stream.destroyed) stream.destroy(abortReason(signal));
  };
  const cleanup = () => signal.removeEventListener("abort", abort);

  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  stream.once("close", cleanup);
  return cleanup;
}

export function throwIfAborted(signal, fallbackError) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw materializeError(fallbackError);
}

function abortReason(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("PrivacyAI request aborted."), { name: "AbortError" });
}

function materializeError(value) {
  const error = typeof value === "function" ? value() : value;
  return error instanceof Error
    ? error
    : Object.assign(new Error("PrivacyAI request aborted."), { name: "AbortError" });
}
