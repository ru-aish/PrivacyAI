import { createHash } from "node:crypto";

import {
  DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS,
  PrivateAI,
  ProviderError,
  STRICT_PRIVACY_SANITIZER_PROMPT,
  derivePrivacyInputTokenBudget,
  normalizeLocalModelContextTokens,
  normalizePrivacyOutputTokens
} from "@privacy-ai/sdk";

const DEFAULT_TRANSIENT_RETRY_COUNT = 1;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 100;

export function createPrivacySanitizer(config, options = {}) {
  if (options.sanitizer) return options.sanitizer;

  const privacyMaxTokens = derivePrivacyMaxTokens(config, options);
  const client = options.privacyClient || new PrivateAI({
    provider: config.provider,
    model: config.model,
    privacyModel: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    numCtx: config.numCtx,
    fallbackNumCtx: config.fallbackNumCtx,
    keepAlive: config.keepAlive,
    fetch: options.fetch,
    privacyMaxTokens,
    classifierConcurrency: options.classifierConcurrency ?? config.classifierConcurrency,
    sanitizationMode: "strict",
    loadEnv: false
  });
  const retryCount = transientRetryCount(options.transientProviderRetryCount);
  const retryDelayMs = transientRetryDelay(options.transientProviderRetryDelayMs);

  const sanitizer = async (prompt, sanitizeOptions = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return normalizeSanitizerResult(await client.sanitize(prompt, sanitizeOptions));
      } catch (error) {
        if (
          attempt >= retryCount ||
          !isTransientProviderError(error, sanitizeOptions.signal)
        ) {
          throw error;
        }
        await waitForRetry(retryDelayMs, sanitizeOptions.signal);
      }
    }
  };
  const identity = {
    boundary: "strict-agent",
    policyVersion: 3,
    model: String(config.model || ""),
    baseURL: String(config.baseURL || ""),
    promptHash: createHash("sha256").update(STRICT_PRIVACY_SANITIZER_PROMPT).digest("hex"),
    structuredIdentityConfidenceThreshold: 0.85,
    privacyMaxTokens
  };
  sanitizer.identity = {
    ...identity,
    fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  };
  return sanitizer;
}

export function isTransientProviderError(error, signal) {
  if (!(error instanceof ProviderError) || signal?.aborted) return false;
  if (String(error.code || "").startsWith("PRIVACYAI_")) return false;

  const status = Number(error.details?.status);
  if (Number.isInteger(status)) return status >= 500 && status <= 599;

  const message = String(error.message || "");
  if (/(?:request failed|request timed out|returned non-JSON response)/i.test(message)) {
    return true;
  }
  return /response did not include (?:choices\[0\]\.message\.content|message\.content)/i.test(message) &&
    error.details?.error != null;
}

export function derivePrivacyMaxTokens(_config = {}, options = {}) {
  return normalizePrivacyOutputTokens(options.privacyMaxTokens);
}

export function derivePrivacyContextMaxTokens(config = {}, options = {}) {
  if (options.providerContextMaxTokens != null) {
    const explicit = Number(options.providerContextMaxTokens);
    if (!Number.isSafeInteger(explicit) || explicit <= 0) {
      throw new TypeError("providerContextMaxTokens must be a positive safe integer.");
    }
    return explicit;
  }
  return derivePrivacyInputTokenBudget(
    normalizedContextTokens(config.numCtx),
    derivePrivacyMaxTokens(config, options)
  );
}

export function derivePrivacyContextMaxChars(config = {}, options = {}) {
  if (options.providerContextMaxChars != null) {
    const explicit = Number(options.providerContextMaxChars);
    if (!Number.isSafeInteger(explicit) || explicit <= 0) {
      throw new TypeError("providerContextMaxChars must be a positive safe integer.");
    }
    return explicit;
  }

  // Keep an independent hard character ceiling even though batching is token
  // aware. This protects reconstruction memory and prevents a permissive exact
  // tokenizer from creating giant classifier payloads.
  return derivePrivacyContextMaxTokens(config, options) * 2;
}

function normalizedContextTokens(value) {
  return normalizeLocalModelContextTokens(value, DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS);
}

function transientRetryCount(value) {
  if (value == null) return DEFAULT_TRANSIENT_RETRY_COUNT;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 3) {
    throw new TypeError("transientProviderRetryCount must be an integer between 0 and 3.");
  }
  return count;
}

function transientRetryDelay(value) {
  if (value == null) return DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const delay = Number(value);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 10000) {
    throw new TypeError("transientProviderRetryDelayMs must be an integer between 0 and 10000.");
  }
  return delay;
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (delayMs === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("PrivacyAI stopped local sanitization because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_REQUEST_ABORTED";
  return error;
}

export function normalizeSanitizerResult(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("PrivacyAI sanitizer returned an invalid result.");
  }

  const sanitizedPrompt = result.sanitizedText ?? result.safe_prompt;
  const sessionMap = result.sessionMap ?? result.session_map ?? {};
  if (typeof sanitizedPrompt !== "string") {
    throw new TypeError("PrivacyAI sanitizer did not return sanitized text.");
  }

  return { sanitizedPrompt, sessionMap };
}
