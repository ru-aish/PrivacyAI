import { GENERATED_DUMMY_PATTERN_SOURCE } from "./dummy-data.js";
import { restore as restoreTextValue } from "./redactor.js";

const DEFAULT_PLACEHOLDER_PATTERN = new RegExp(
  String.raw`(?:\[[A-Z][A-Z0-9_]*_\d+\]|${GENERATED_DUMMY_PATTERN_SOURCE})`,
  "gi"
);

export function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([placeholder, original]) =>
        typeof placeholder === "string" &&
        typeof original === "string" &&
        placeholder.length > 0 &&
        original.length > 0 &&
        placeholder !== original
    )
  );
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
  const pattern = new RegExp(
    candidates.map(candidate => escapeRegExp(candidate.value)).join("|"),
    "gi"
  );

  return text.replace(pattern, match => {
    const candidate = matchingCandidate(match, candidates);
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

function matchingCandidate(match, candidates) {
  const normalized = match.toLocaleLowerCase("en-US");
  const candidate = candidates.find(entry =>
    entry.value.toLocaleLowerCase("en-US") === normalized ||
    new RegExp(`^(?:${escapeRegExp(entry.value)})$`, "i").test(match)
  );
  if (!candidate) {
    throw new Error("PrivacyAI could not resolve a known-value replacement.");
  }
  return candidate;
}
export function transformValue(value, transformText) {
  if (typeof transformText !== "function") {
    throw new TypeError("transformValue requires a text transformation function.");
  }
  if (typeof value === "string") return transformText(value);
  if (Array.isArray(value)) return value.map(item => transformValue(item, transformText));

  if (value && typeof value === "object") {
    const transformed = {};
    for (const [key, item] of Object.entries(value)) {
      const transformedKey = transformText(key);
      if (Object.hasOwn(transformed, transformedKey)) {
        const error = new Error("PrivacyAI blocked a structured value because key transformation caused a collision.");
        error.code = "PRIVACYAI_TRANSFORM_KEY_COLLISION";
        throw error;
      }
      Object.defineProperty(transformed, transformedKey, {
        value: transformValue(item, transformText),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return transformed;
  }

  return value;
}

export function restoreValue(value, sessionMap = {}) {
  return transformValue(value, text => restoreText(text, sessionMap));
}

export function sanitizeKnownValue(value, sessionMap = {}) {
  return transformValue(value, text => sanitizeKnownText(text, sessionMap));
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

export function assertNoProtectedOriginalsInValue(value, sessionMap = {}) {
  const normalizedMap = normalizeSessionMap(sessionMap);
  const leaks = new Set();
  visitText(value, text => {
    for (const original of protectedOriginalsInText(text, normalizedMap)) leaks.add(original);
  });
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

function visitText(value, visitor) {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) visitText(entry, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    visitor(key);
    visitText(entry, visitor);
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
