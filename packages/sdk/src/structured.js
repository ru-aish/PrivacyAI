import {
  mergeSessionMaps,
  normalizeSessionMap,
  rebaseSessionAdditions
} from "./session-map-contract.js";
import {
  compileKnownSanitizer,
  sanitizeKnownText
} from "./placeholder-transform.js";
import { assertNoProtectedOriginalsInValue } from "./privacy-assertions.js";
import {
  describeStructuredValue,
  rebuildStructuredValue,
  structuredValuesEqual
} from "./structured-value.js";
import {
  buildStructuredBatches,
  contextWindowError,
  encodeBatch
} from "./structured-chunks.js";
import {
  recoverClassifierAdditions,
  shieldKnownValues
} from "./classifier-boundary.js";
import { estimatePrivacyTokens, normalizeTokenBudget } from "./token-budget.js";

const DEFAULT_MAX_CONTEXT_CHARS = 200000;

/**
 * Sanitize a JSON-compatible value as bounded text batches. The local model
 * identifies exact private spans; PrivacyAI reconstructs the original shape
 * and applies placeholders locally.
 */
export async function sanitizeStructuredValue(value, options = {}) {
  throwIfAborted(options.signal);
  const initialMap = normalizeSessionMap(options.sessionMap);
  const limits = classifierLimits(options);
  const slots = [];
  const template = describeStructuredValue(value, slots, options);

  if (slots.length === 0) {
    return { value, sessionMapAdditions: {}, changed: false };
  }
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Structured privacy sanitization requires a sanitizer function.");
  }

  const { unitCount, batches } = buildStructuredBatches(slots, limits);
  const state = { completeMap: initialMap, additions: {} };
  const artifactType = options.artifactType || "structured_context";
  let packedChars = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    throwIfAborted(options.signal);
    const batch = batches[batchIndex];
    const rawBatchText = encodeBatch(batch);
    const inputTokens = limits.countTokens(rawBatchText);
    if (
      rawBatchText.length > limits.maxContextChars ||
      inputTokens > limits.maxContextTokens
    ) {
      throw contextWindowError(limits.maxContextChars, limits.maxContextTokens);
    }

    packedChars += rawBatchText.length;
    const shield = shieldKnownValues(rawBatchText, state.completeMap);
    let classifierResult = await options.sanitizer(shield.text, {
      identityConfidenceThreshold: options.identityConfidenceThreshold ?? 0.85,
      artifactType,
      identity: options.identity,
      signal: options.signal
    });
    throwIfAborted(options.signal);
    classifierResult = normalizeClassifierResult(classifierResult);

    if (typeof options.normalizeClassifierResult === "function") {
      classifierResult = await options.normalizeClassifierResult({
        ...classifierResult,
        sourceText: shield.text,
        artifactType,
        batchIndex,
        batchCount: batches.length
      });
      throwIfAborted(options.signal);
      classifierResult = normalizeClassifierResult(classifierResult, true);
    }

    const expected = sanitizeKnownText(shield.text, classifierResult.sessionMap);
    if (classifierResult.sanitizedPrompt !== expected) throw invalidSanitizedContextError();

    const additions = recoverClassifierAdditions(
      rawBatchText,
      classifierResult.sessionMap,
      shield
    );
    mergeClassifierAdditions(additions, state);

    if (typeof options.onBatchComplete === "function") {
      await options.onBatchComplete({
        batchIndex,
        batchCount: batches.length,
        unitCount: batch.length,
        inputChars: rawBatchText.length,
        estimatedInputTokens: inputTokens
      });
      throwIfAborted(options.signal);
    }
  }

  const sanitizeKnown = compileKnownSanitizer(state.completeMap);
  const resolved = slots.map(slot => sanitizeKnown(slot.value));
  const sanitizedValue = rebuildStructuredValue(template, resolved);
  assertNoProtectedOriginalsInValue(sanitizedValue, state.completeMap, {
    includeKeys: options.sanitizeObjectKeys
  });

  const identityMapAdditions = options.identity?.describeSessionMap?.(state.additions, {
    domain: artifactType
  });
  return {
    value: sanitizedValue,
    sessionMapAdditions: state.additions,
    ...(identityMapAdditions ? { identityMapAdditions } : {}),
    changed: !structuredValuesEqual(value, sanitizedValue),
    metrics: {
      modelCallCount: batches.length,
      batchCount: batches.length,
      unitCount,
      packedChars
    }
  };
}

function classifierLimits(options) {
  const maxContextChars = Number(options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS);
  if (!Number.isSafeInteger(maxContextChars) || maxContextChars <= 0) {
    throw new TypeError("maxContextChars must be a positive safe integer.");
  }
  const maxContextTokens = normalizeTokenBudget(
    options.maxContextTokens,
    Math.max(2048, Math.floor(maxContextChars / 2))
  );
  return {
    maxContextChars,
    maxContextTokens,
    countTokens: text => estimatePrivacyTokens(text, options.tokenCounter)
  };
}

function normalizeClassifierResult(result, normalized = false) {
  const message = normalized
    ? "Classifier-result normalization must return sanitizedPrompt."
    : "Context privacy sanitizer did not return sanitizedPrompt.";
  if (!result || typeof result.sanitizedPrompt !== "string") {
    throw new TypeError(message);
  }
  return {
    sanitizedPrompt: result.sanitizedPrompt,
    sessionMap: normalizeSessionMap(result.sessionMap)
  };
}

function mergeClassifierAdditions(additions, state) {
  if (Object.keys(additions).length === 0) return;
  const rebased = rebaseSessionAdditions("", additions, state.completeMap);
  state.completeMap = mergeSessionMaps(state.completeMap, rebased.sessionMap);
  state.additions = mergeSessionMaps(state.additions, rebased.sessionMap);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PrivacyAI stopped sanitization because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_REQUEST_ABORTED";
  throw error;
}

function invalidSanitizedContextError() {
  const error = new Error(
    "PrivacyAI blocked structured context because the local sanitizer changed text outside exact private spans."
  );
  error.code = "PRIVACYAI_INVALID_SANITIZED_CONTEXT";
  return error;
}
