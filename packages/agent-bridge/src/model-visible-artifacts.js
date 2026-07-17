import { createHash } from "node:crypto";

import {
  assertNoProtectedOriginalsInValue,
  normalizeSessionMap,
  rebaseSessionAdditions,
  sanitizeKnownValue,
  sanitizeStructuredValue
} from "@privacy-ai/sdk";
import { packUncachedArtifactEntries } from "./artifact-packing.js";

/**
 * Sanitize a protocol adapter's model-visible slots while reusing persistent
 * verification records. Protocol modules own slot discovery and application;
 * this module owns only classification, stable mappings, batching, and cache
 * metadata.
 */
export async function sanitizeModelVisibleArtifacts(slots, options = {}) {
  if (!Array.isArray(slots)) {
    throw new TypeError("Model-visible artifacts must be an array.");
  }
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Model-visible artifact transformation requires a sanitizer function.");
  }
  throwIfAborted(options.signal);

  const normalized = slots.map((entry, index) => normalizeSlot(entry, index));
  const policyFingerprint = String(options.policyFingerprint || "privacyai-agent-strict-v2");
  const completeMap = normalizeSessionMap(options.sessionMap);
  const sessionMapAdditions = {};
  const cacheWrites = [];
  const itemRecords = [];
  const uniqueByContent = new Map();
  let cacheHitCount = 0;
  let uncachedSlotCount = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    const entry = normalized[index];
    const contentHash = contentHashFor(entry.value);
    const cacheKey = verificationKey(entry.value, entry.artifactType, policyFingerprint);
    const cached = options.cache?.get?.(cacheKey, policyFingerprint);

    itemRecords.push({
      slotKey: entry.slotKey,
      cacheKey,
      contentHash,
      artifactType: entry.artifactType
    });

    if (cached?.sessionMapAdditions && typeof cached.sessionMapAdditions === "object") {
      mergeMappings(completeMap, sessionMapAdditions, cached.sessionMapAdditions);
      cacheHitCount += 1;
      continue;
    }

    uncachedSlotCount += 1;
    const candidate = { ...entry, index, cacheKey, contentHash };
    const existing = uniqueByContent.get(contentHash);
    if (existing) {
      existing.destinations.push(candidate);
    } else {
      uniqueByContent.set(contentHash, { ...candidate, destinations: [candidate] });
    }
  }

  const uncached = [...uniqueByContent.values()];
  const groups = packUncachedArtifactEntries(uncached, {
    maxContextChars: options.maxContextChars,
    maxContextTokens: options.maxContextTokens,
    tokenCounter: options.tokenCounter
  });
  const originalArtifactCount = groups.reduce((count, pack) => count + pack.artifacts.length, 0);
  let modelCallCount = 0;
  let packedChars = 0;
  for (let artifactIndex = 0; artifactIndex < groups.length; artifactIndex += 1) {
    throwIfAborted(options.signal);
    const artifact = groups[artifactIndex];
    const rawResult = await sanitizeStructuredValue(
      artifact.entries.map(entry => entry.value),
      {
        sanitizer: options.sanitizer,
        sessionMap: completeMap,
        maxContextChars: options.maxContextChars,
        maxContextTokens: options.maxContextTokens,
        tokenCounter: options.tokenCounter,
        artifactType: `${options.artifactTypePrefix || "model"}_${artifact.artifactType}`,
        signal: options.signal,
        onBatchComplete: async details => {
          modelCallCount += 1;
          packedChars += Number(details.inputChars || 0);
          if (typeof options.onBatchComplete === "function") {
            await options.onBatchComplete({
              ...details,
              artifactIndex,
              artifactCount: groups.length,
              artifactKey: artifact.artifactKey,
              artifactType: artifact.artifactType,
              uniqueUncachedCount: uncached.length,
              uncachedSlotCount,
              cacheHitCount,
              deduplicatedCount: uncachedSlotCount - uncached.length,
              modelCallCount,
              packedChars
            });
          }
        }
      }
    );
    const result = typeof options.normalizeArtifactResult === "function"
      ? await options.normalizeArtifactResult({
          value: rawResult.value,
          sessionMapAdditions: rawResult.sessionMapAdditions || {},
          sourceValues: artifact.entries.map(entry => entry.value),
          existingSessionMap: { ...completeMap },
          artifactKey: artifact.artifactKey,
          artifactType: artifact.artifactType
        })
      : rawResult;

    if (!result || !Array.isArray(result.value) || result.value.length !== artifact.entries.length) {
      throw invalidShapeError(options);
    }

    const discoveredMap = { ...completeMap, ...(result.sessionMapAdditions || {}) };
    for (const entry of artifact.entries) {
      const verificationMap = relevantMappings(entry.value, discoveredMap);
      mergeMappings(completeMap, sessionMapAdditions, verificationMap);
      const writtenKeys = new Set();
      for (const destination of entry.destinations) {
        if (writtenKeys.has(destination.cacheKey)) continue;
        writtenKeys.add(destination.cacheKey);
        cacheWrites.push([destination.cacheKey, {
          cacheKey: destination.cacheKey,
          contentHash: destination.contentHash,
          artifactType: destination.artifactType,
          policyFingerprint,
          sessionMapAdditions: verificationMap
        }]);
      }
    }

    if (typeof options.onArtifactComplete === "function") {
      for (const originalArtifact of artifact.artifacts) {
        await options.onArtifactComplete({
          artifactIndex: originalArtifact.artifactIndex,
          artifactCount: originalArtifactCount,
          artifactKey: originalArtifact.artifactKey,
          artifactType: originalArtifact.artifactType,
          slotCount: originalArtifact.entries.reduce(
            (count, entry) => count + entry.destinations.length,
            0
          ),
          uniqueUncachedCount: uncached.length,
          uncachedSlotCount,
          cacheHitCount,
          deduplicatedCount: uncachedSlotCount - uncached.length,
          modelCallCount,
          packedChars
        });
      }
    }
  }

  const values = normalized.map(entry => sanitizeKnownValue(entry.value, completeMap));
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].mutable || valuesEqual(values[index], normalized[index].value)) continue;
    throw immutableValueError(options, normalized[index]);
  }

  assertNoProtectedOriginalsInValue(values, completeMap);

  return {
    values,
    sessionMap: completeMap,
    sessionMapAdditions,
    cacheWrites,
    itemRecords,
    policyFingerprint,
    metrics: {
      uniqueUncachedCount: uncached.length,
      uncachedSlotCount,
      cacheHitCount,
      deduplicatedCount: uncachedSlotCount - uncached.length,
      modelCallCount,
      packedChars
    }
  };
}

function normalizeSlot(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`Model-visible slot ${index} must be an object.`);
  }
  const slotKey = requiredLabel(entry.slotKey, `slot ${index} key`);
  const artifactType = requiredLabel(entry.artifactType, `slot ${index} artifact type`);
  return {
    value: entry.value,
    slotKey,
    artifactType,
    artifactKey: requiredLabel(entry.artifactKey || slotKey, `slot ${index} artifact key`),
    mutable: entry.mutable !== false,
    label: String(entry.label || slotKey)
  };
}

function requiredLabel(value, label) {
  const normalized = String(value || "");
  if (!normalized) throw new TypeError(`Model-visible ${label} must be non-empty.`);
  return normalized;
}

function verificationKey(value, artifactType, policyFingerprint) {
  return createHash("sha256")
    .update(String(policyFingerprint))
    .update("\0")
    .update(String(artifactType))
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function contentHashFor(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mergeMappings(completeMap, aggregateAdditions, additions) {
  const normalized = Object.fromEntries(Object.entries(additions || {}).filter(
    ([placeholder, original]) =>
      typeof placeholder === "string" && placeholder.length > 0 &&
      typeof original === "string" && original.length > 0 &&
      placeholder !== original
  ));
  if (Object.keys(normalized).length === 0) return;

  const rebased = rebaseSessionAdditions(
    JSON.stringify(Object.keys(normalized)),
    normalized,
    completeMap
  );
  const candidate = normalizeSessionMap({ ...completeMap, ...rebased.sessionMap });
  Object.assign(completeMap, candidate);
  Object.assign(aggregateAdditions, rebased.sessionMap);
}

function relevantMappings(value, sessionMap) {
  const strings = [];
  collectStrings(value, strings);
  const normalizedStrings = strings.map(text => text.toLocaleLowerCase("en-US"));
  return Object.fromEntries(Object.entries(sessionMap || {}).filter(([, original]) => {
    if (typeof original !== "string" || original.length === 0) return false;
    const target = original.toLocaleLowerCase("en-US");
    return normalizedStrings.some(text => text.includes(target));
  }));
}

function collectStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(entry => collectStrings(entry, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    output.push(key);
    collectStrings(entry, output);
  }
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalidShapeError(options) {
  if (typeof options.invalidShapeError === "function") return options.invalidShapeError();
  return protocolError(
    "PRIVACYAI_INVALID_SANITIZED_MODEL_CONTENT",
    "PrivacyAI blocked the model request because sanitization changed its model-visible shape."
  );
}

function immutableValueError(options, entry) {
  if (typeof options.immutableValueError === "function") return options.immutableValueError(entry);
  return protocolError(
    "PRIVACYAI_UNRESTORABLE_MODEL_IDENTIFIER",
    `PrivacyAI blocked a private value in an immutable protocol identifier: ${entry.label}`
  );
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PrivacyAI model-content transformation was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
