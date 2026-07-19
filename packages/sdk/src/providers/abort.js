export function createProviderAbortContext(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout() {
      return timedOut;
    },
    externallyAborted() {
      return Boolean(externalSignal?.aborted);
    },
    externalReason() {
      return externalSignal?.reason;
    },
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

export function providerCancellationError(ProviderErrorClass, reason) {
  const error = new ProviderErrorClass(
    "Provider request cancelled because the PrivacyAI client disconnected.",
    reason
  );
  error.code = reason?.code || "PRIVACYAI_REQUEST_ABORTED";
  return error;
}
