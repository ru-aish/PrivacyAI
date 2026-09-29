import {
  DEFAULT_CLASSIFIER_CONCURRENCY,
  normalizeClassifierConcurrency
} from "./local-model-policy.js";

export class AsyncConcurrencyLimiter {
  constructor(concurrency = DEFAULT_CLASSIFIER_CONCURRENCY) {
    this.concurrency = normalizeClassifierConcurrency(concurrency);
    this.active = 0;
    this.queue = [];
  }

  run(operation, signal) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Concurrency limiter requires an operation function."));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const entry = { operation, signal, resolve, reject, started: false, onAbort: null };
      entry.onAbort = () => {
        if (entry.started) return;
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", entry.onAbort);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry.signal?.aborted) {
        entry.signal.removeEventListener("abort", entry.onAbort);
        entry.reject(abortReason(entry.signal));
        continue;
      }
      entry.started = true;
      entry.signal?.removeEventListener("abort", entry.onAbort);
      this.active += 1;
      Promise.resolve()
        .then(entry.operation)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.#drain();
        });
    }
  }
}

export function createConcurrencyLimiter(concurrency) {
  const limiter = new AsyncConcurrencyLimiter(concurrency);
  return (operation, signal) => limiter.run(operation, signal);
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("PrivacyAI stopped queued local-model work because the request was cancelled.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_REQUEST_ABORTED";
  return error;
}
