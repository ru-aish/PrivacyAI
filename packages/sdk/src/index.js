export { PrivateAI, createClient } from "./client.js";
export { PrivacySanitizer } from "./sanitizer.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export { OllamaProvider } from "./providers/ollama.js";
export { restore, redact } from "./redactor.js";
export { configFromEnv, loadEnvFile } from "./config.js";
export {
  PRIVACY_SANITIZER_PROMPT,
  STRICT_PRIVACY_SANITIZER_PROMPT,
  BROWSER_PRIVACY_SANITIZER_PROMPT,
  EXACT_TEXT_EDIT_PROMPT,
  CONTEXT_COMPACTOR_PROMPT,
  DEFAULT_SYSTEM_PROMPT
} from "./prompts.js";
export {
  AiSanitizer,
  SANITIZATION_MODES,
  parseSanitizerEdits,
  parseSanitizerJson,
  parseSanitizerSpans
} from "./ai-sanitizer.js";
export { ContextCompactor, parseCompactorJson } from "./context-compactor.js";
export {
  allocateUniqueDummy,
  generateDummy,
  GENERATED_DUMMY_PATTERN_SOURCE
} from "./dummy-data.js";
export { localSanitize } from "./local-sanitizer.js";
export { RegexDetector } from "./detectors/regex.js";
export {
  PrivacyError,
  PrivacyGuardianError,
  ProviderError,
  createPrivacyError,
  isPrivacyError,
  privacyErrorPolicy,
  sanitizePrivacyDiagnostics,
  serializePrivacyError
} from "./errors.js";
export {
  assertNoProtectedOriginals,
  assertNoProtectedOriginalsInValue,
  findUnresolvedPlaceholders,
  normalizeSessionMap,
  rebaseSessionAdditions,
  restoreText,
  restoreValue,
  sanitizeKnownText,
  sanitizeKnownValue,
  transformValue
} from "./session-map.js";
export { sanitizeStructuredValue } from "./structured.js";
export { estimatePrivacyTokens, normalizeTokenBudget } from "./token-budget.js";
export { AsyncConcurrencyLimiter, createConcurrencyLimiter } from "./concurrency-limiter.js";
export {
  DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS,
  OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS,
  MIN_LOCAL_MODEL_CONTEXT_TOKENS,
  MAX_LOCAL_MODEL_CONTEXT_TOKENS,
  DEFAULT_PRIVACY_OUTPUT_TOKENS,
  MIN_PRIVACY_OUTPUT_TOKENS,
  MAX_PRIVACY_OUTPUT_TOKENS,
  TRUNCATED_PRIVACY_OUTPUT_TOKENS,
  DEFAULT_CLASSIFIER_CONCURRENCY,
  MAX_CLASSIFIER_CONCURRENCY,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  normalizeLocalModelContextTokens,
  normalizePrivacyOutputTokens,
  normalizeClassifierConcurrency,
  normalizeOllamaKeepAlive,
  derivePrivacyInputTokenBudget
} from "./local-model-policy.js";
export {
  TextEditGenerator,
  applyTextEdits,
  parseAndApplyTextEdits
} from "./text-edits.js";
export { StreamingPlaceholderRestorer } from "./streaming-restorer.js";
export {
  CANONICAL_PRIVACY_PLACEHOLDER_PATTERN_SOURCE,
  PRIVACY_PLACEHOLDER_CONTRACT_VERSION,
  formatPrivacyPlaceholder,
  isCanonicalPrivacyPlaceholder,
  normalizePrivacyCategory,
  parsePrivacyPlaceholder,
  privacyCategoryFromAlias,
  validatePrivacyPlaceholder
} from "./placeholder-identity.js";
export {
  PRIVACY_IDENTITY_CONTRACT_VERSION,
  PRIVACY_IDENTITY_SCOPE_KINDS,
  canonicalizeProtectedValue,
  normalizePrivacyIdentityScope,
  stableIdentitySerialize
} from "./identity-contract.js";

import { PrivateAI } from "./client.js";

export async function ask(prompt, options = {}) {
  return new PrivateAI(options).ask(prompt, options);
}

export async function sanitize(prompt, options = {}) {
  return new PrivateAI(options).sanitize(prompt);
}

export async function inspect(prompt, options = {}) {
  return new PrivateAI(options).inspect(prompt);
}
