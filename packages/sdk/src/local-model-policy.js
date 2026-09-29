export const DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS = 8192;
export const OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS = 6144;
export const MIN_LOCAL_MODEL_CONTEXT_TOKENS = 2048;
export const MAX_LOCAL_MODEL_CONTEXT_TOKENS = 32768;

export const DEFAULT_PRIVACY_OUTPUT_TOKENS = 512;
export const MIN_PRIVACY_OUTPUT_TOKENS = 256;
export const MAX_PRIVACY_OUTPUT_TOKENS = 512;
export const TRUNCATED_PRIVACY_OUTPUT_TOKENS = 1024;

export const DEFAULT_CLASSIFIER_CONCURRENCY = 1;
export const MAX_CLASSIFIER_CONCURRENCY = 2;
export const DEFAULT_OLLAMA_KEEP_ALIVE = "10m";

export function normalizeLocalModelContextTokens(value, fallback = DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS) {
  const tokens = value == null || value === "" ? Number(fallback) : Number(value);
  if (
    !Number.isSafeInteger(tokens) ||
    tokens < MIN_LOCAL_MODEL_CONTEXT_TOKENS ||
    tokens > MAX_LOCAL_MODEL_CONTEXT_TOKENS
  ) {
    throw new TypeError(
      `Local-model context must be an integer between ${MIN_LOCAL_MODEL_CONTEXT_TOKENS} and ${MAX_LOCAL_MODEL_CONTEXT_TOKENS} tokens.`
    );
  }
  return tokens;
}

export function normalizePrivacyOutputTokens(value, fallback = DEFAULT_PRIVACY_OUTPUT_TOKENS) {
  const tokens = value == null || value === "" ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(tokens) || tokens < MIN_PRIVACY_OUTPUT_TOKENS) {
    throw new TypeError(`Privacy-model output must be at least ${MIN_PRIVACY_OUTPUT_TOKENS} tokens.`);
  }
  return Math.min(tokens, MAX_PRIVACY_OUTPUT_TOKENS);
}

export function normalizeClassifierConcurrency(value, fallback = DEFAULT_CLASSIFIER_CONCURRENCY) {
  const concurrency = value == null || value === "" ? Number(fallback) : Number(value);
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CLASSIFIER_CONCURRENCY
  ) {
    throw new TypeError(
      `Classifier concurrency must be an integer between 1 and ${MAX_CLASSIFIER_CONCURRENCY}.`
    );
  }
  return concurrency;
}

export function normalizeOllamaKeepAlive(value, fallback = DEFAULT_OLLAMA_KEEP_ALIVE) {
  const keepAlive = String(value == null || value === "" ? fallback : value).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(keepAlive);
  if (!match) {
    throw new TypeError("Ollama keepAlive must be a bounded duration such as 10m, 30s, or 0.");
  }
  const amount = Number(match[1]);
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const durationMs = amount * (multipliers[match[2] || "s"] || 1000);
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000) {
    throw new TypeError("Ollama keepAlive must be between 0 and 24 hours.");
  }
  return keepAlive;
}

export function derivePrivacyInputTokenBudget(contextTokens, outputTokens = DEFAULT_PRIVACY_OUTPUT_TOKENS) {
  const context = normalizeLocalModelContextTokens(contextTokens);
  const output = normalizePrivacyOutputTokens(outputTokens);
  const protocolReserve = Math.max(768, Math.floor(context / 8));
  const budget = context - output - protocolReserve;
  if (budget < 768) {
    throw new TypeError("Local-model context is too small for the privacy classifier protocol.");
  }
  return budget;
}
