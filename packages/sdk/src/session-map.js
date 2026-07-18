import { GENERATED_DUMMY_PATTERN_SOURCE } from "./dummy-data.js";
import { restore as restoreTextValue } from "./redactor.js";

const DEFAULT_PLACEHOLDER_PATTERN = new RegExp(
  String.raw`(?:\[[A-Z][A-Z0-9_]*_\d+\]|${GENERATED_DUMMY_PATTERN_SOURCE})`,
  "gi"
);
const UNSAFE_SESSION_MAP_PLACEHOLDERS = new Set(["__proto__", "prototype", "constructor"]);

export function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(
    ([placeholder, original]) =>
      typeof placeholder === "string" &&
      typeof original === "string" &&
      placeholder.length > 0 &&
      original.length > 0 &&
      placeholder !== original
  );
  assertSafeSessionMapPlaceholders(entries);
  assertUnambiguousSessionMap(entries);
  return Object.fromEntries(entries);
}

function assertSafeSessionMapPlaceholders(entries) {
  for (const [placeholder] of entries) {
    if (!UNSAFE_SESSION_MAP_PLACEHOLDERS.has(foldSessionMapValue(placeholder))) {
      continue;
    }
    const error = new Error("PrivacyAI blocked an unsafe session-map placeholder.");
    error.code = "PRIVACYAI_INVALID_SESSION_MAP";
    throw error;
  }
}

function assertUnambiguousSessionMap(entries) {
  const placeholders = new Map();
  const originals = new Map();

  for (const [placeholder, original] of entries) {
    const placeholderKey = foldSessionMapValue(placeholder);
    const originalKey = foldSessionMapValue(original);
    const existingPlaceholder = placeholders.get(placeholderKey);
    if (existingPlaceholder && existingPlaceholder !== placeholder) {
      throw ambiguousSessionMapError();
    }
    placeholders.set(placeholderKey, placeholder);

    const existingOriginal = originals.get(originalKey);
    if (existingOriginal && existingOriginal !== original) {
      throw ambiguousSessionMapError();
    }
    originals.set(originalKey, original);
  }

  for (const placeholderKey of placeholders.keys()) {
    if (originals.has(placeholderKey)) throw ambiguousSessionMapError();
  }
}

function foldSessionMapValue(value) {
  return value.toLocaleLowerCase("en-US");
}

function ambiguousSessionMapError() {
  const error = new Error(
    "PrivacyAI blocked a session map with ambiguous case-insensitive aliases."
  );
  error.code = "PRIVACYAI_AMBIGUOUS_SESSION_MAP";
  return error;
}

export function rebaseSessionAdditions(sanitizedText, additions = {}, existing = {}) {
  if (typeof sanitizedText !== "string") {
    throw new TypeError("Sanitizer did not return sanitized text.");
  }

  const normalizedExisting = normalizeSessionMap(existing);
  const normalizedAdditions = normalizeSessionMap(additions);
  let text = sanitizedText;
  const sessionMap = {};
  const occupied = new Set([...Object.keys(normalizedExisting), ...Object.keys(normalizedAdditions)]);

  for (const [placeholder, original] of Object.entries(normalizedAdditions)) {
    const existingPlaceholder = Object.entries(normalizedExisting).find(([, value]) => value === original)?.[0];
    if (existingPlaceholder) {
      if (existingPlaceholder !== placeholder) text = text.split(placeholder).join(existingPlaceholder);
      continue;
    }

    let target = placeholder;
    if (Object.hasOwn(normalizedExisting, placeholder) && normalizedExisting[placeholder] !== original) {
      target = allocatePrivatePlaceholder(placeholder, occupied);
      text = text.split(placeholder).join(target);
    }
    occupied.add(target);
    sessionMap[target] = original;
  }

  return { sanitizedText: text, sessionMap };
}

export function restoreText(text, sessionMap = {}) {
  if (typeof text !== "string") return text;
  return restoreTextValue(text, normalizeSessionMap(sessionMap));
}

export function sanitizeKnownText(text, sessionMap = {}) {
  if (typeof text !== "string") return text;
  const replacements = Object.entries(normalizeSessionMap(sessionMap));
  if (replacements.length === 0) return text;

  // Replace against the original input in one pass. This prevents a later
  // mapping from matching inside a placeholder inserted by an earlier one.
  const candidates = replacementCandidates(replacements);
  const candidatesByValue = new Map(
    candidates.map(candidate => [foldSessionMapValue(candidate.value), candidate])
  );
  const pattern = new RegExp(
    candidates.map(candidate => escapeRegExp(candidate.value)).join("|"),
    "gi"
  );

  return text.replace(pattern, match => {
    const candidate = candidatesByValue.get(foldSessionMapValue(match));
    if (!candidate) {
      throw new Error("PrivacyAI could not resolve a known-value replacement.");
    }
    return candidate.kind === "placeholder" ? match : candidate.placeholder;
  });
}

function replacementCandidates(replacements) {
  const candidates = [];
  const occupied = new Set();
  const add = candidate => {
    const key = candidate.value.toLocaleLowerCase("en-US");
    if (occupied.has(key)) return;
    occupied.add(key);
    candidates.push(candidate);
  };

  for (const [placeholder] of replacements) {
    add({ kind: "placeholder", value: placeholder, placeholder });
  }
  for (const [placeholder, original] of replacements) {
    add({ kind: "original", value: original, placeholder });
  }

  return candidates.sort((left, right) =>
    right.value.length - left.value.length ||
    Number(left.kind !== "placeholder") - Number(right.kind !== "placeholder")
  );
}

export function transformValue(value, transformText, options = {}, path = []) {
  if (typeof transformText !== "function") {
    throw new TypeError("transformValue requires a text transformation function.");
  }
  if (typeof value === "string") return transformText(value);
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      transformValue(item, transformText, options, [...path, index])
    );
  }

  if (value && typeof value === "object") {
    const transformed = {};
    for (const [key, item] of Object.entries(value)) {
      const keyPath = [...path, key];
      const transformedKey = shouldProcessObjectKey(options.transformKeys, keyPath, key)
        ? transformText(key)
        : key;
      if (Object.hasOwn(transformed, transformedKey)) {
        const error = new Error("PrivacyAI blocked a structured value because key transformation caused a collision.");
        error.code = "PRIVACYAI_TRANSFORM_KEY_COLLISION";
        throw error;
      }
      Object.defineProperty(transformed, transformedKey, {
        value: transformValue(item, transformText, options, keyPath),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return transformed;
  }

  return value;
}

function shouldProcessObjectKey(policy, path, key) {
  if (typeof policy === "function") {
    return policy({ path: [...path], key }) !== false;
  }
  return policy !== false;
}

export function restoreValue(value, sessionMap = {}, options = {}) {
  return transformValue(value, text => restoreText(text, sessionMap), options);
}

export function sanitizeKnownValue(value, sessionMap = {}, options = {}) {
  return transformValue(value, text => sanitizeKnownText(text, sessionMap), options);
}

export function findUnresolvedPlaceholders(value, pattern = DEFAULT_PLACEHOLDER_PATTERN) {
  const source =
    pattern instanceof RegExp
      ? pattern.source
      : typeof pattern === "string"
        ? pattern
        : pattern?.source;
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError(
      "Placeholder pattern must be a RegExp, source string, or RegExp-like object."
    );
  }
  const baseFlags = pattern && typeof pattern.flags === "string" ? pattern.flags : "";
  const flags = baseFlags.includes("g") ? baseFlags : `${baseFlags}g`;
  const matches = new Set();
  transformValue(value, text => {
    const localPattern = new RegExp(source, flags);
    for (const match of text.matchAll(localPattern)) matches.add(match[0]);
    return text;
  });
  return [...matches];
}

export function assertNoProtectedOriginals(serializedPayload, sessionMap = {}) {
  if (typeof serializedPayload !== "string") {
    throw new TypeError("Provider-bound payload must be serialized text.");
  }

  const normalizedMap = normalizeSessionMap(sessionMap);
  const leaks = protectedOriginalsInText(serializedPayload, normalizedMap);
  if (leaks.size > 0) throw providerPayloadLeakError(leaks.size);
}

export function assertNoProtectedOriginalsInValue(value, sessionMap = {}, options = {}) {
  const normalizedMap = normalizeSessionMap(sessionMap);
  const leaks = new Set();
  visitText(value, text => {
    for (const original of protectedOriginalsInText(text, normalizedMap)) leaks.add(original);
  }, options);
  if (leaks.size > 0) throw providerPayloadLeakError(leaks.size);
}

function protectedOriginalsInText(text, sessionMap) {
  let searchableText = String(text).toLocaleLowerCase("en-US");
  for (const placeholder of Object.keys(sessionMap).sort((left, right) => right.length - left.length)) {
    searchableText = searchableText.replace(
      new RegExp(escapeRegExp(placeholder), "gi"),
      match => " ".repeat(match.length)
    );
  }

  const leaks = new Set();
  for (const original of Object.values(sessionMap)) {
    if (searchableText.includes(original.toLocaleLowerCase("en-US"))) leaks.add(original);
  }
  return leaks;
}

function visitText(value, visitor, options = {}, path = []) {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      visitText(value[index], visitor, options, [...path, index]);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = [...path, key];
    if (shouldProcessObjectKey(options.includeKeys, keyPath, key)) visitor(key);
    visitText(entry, visitor, options, keyPath);
  }
}

function providerPayloadLeakError(leakCount) {
  const error = new Error(
    `PrivacyAI blocked provider-bound context because ${leakCount} protected value(s) remained.`
  );
  error.code = "PRIVACYAI_PROVIDER_PAYLOAD_LEAK";
  error.leakCount = leakCount;
  return error;
}

function allocatePrivatePlaceholder(placeholder, occupied) {
  const match = placeholder.match(/^\[([A-Z][A-Z0-9_]*)_(\d+)\]$/);
  const type = match?.[1] || inferPlaceholderType(placeholder);
  let index = match ? Number(match[2]) + 1 : 1;
  let candidate = `[${type}_${index}]`;
  while (occupied.has(candidate)) {
    index += 1;
    candidate = `[${type}_${index}]`;
  }
  return candidate;
}

function inferPlaceholderType(placeholder) {
  if (/api|key|token|secret|credential/i.test(placeholder)) return "API_KEY";
  if (/email|@/.test(placeholder)) return "EMAIL";
  if (/phone|555/.test(placeholder)) return "PHONE";
  return "PRIVATE_VALUE";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
