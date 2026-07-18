import { foldCase } from "./text-matching.js";

const UNSAFE_PLACEHOLDERS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Canonical session maps point from provider-visible placeholders to exact
 * private originals. Restoration is exact; known-original lookup is
 * case-insensitive.
 */
export function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const entries = Object.entries(value)
    .filter(isValidEntry)
    .sort(compareEntries);
  validateEntries(entries);
  return recordFromEntries(entries);
}

export function mergeSessionMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [placeholder, original] of Object.entries(normalizeSessionMap(map))) {
      const previous = merged.get(placeholder);
      if (previous !== undefined && previous !== original) throw ambiguousSessionMapError();
      merged.set(placeholder, original);
    }
  }
  return normalizeSessionMap(recordFromEntries(merged));
}

export function rebaseSessionAdditions(sanitizedText, additions = {}, existing = {}) {
  if (typeof sanitizedText !== "string") {
    throw new TypeError("Sanitizer did not return sanitized text.");
  }

  const normalizedExisting = normalizeSessionMap(existing);
  const normalizedAdditions = normalizeSessionMap(additions);
  assertCompatibleOriginals(normalizedExisting, normalizedAdditions);

  const existingEntries = Object.entries(normalizedExisting);
  const additionEntries = Object.entries(normalizedAdditions);
  const existingByOriginal = new Map();
  const existingPlaceholders = new Map();
  const existingOriginals = new Set();
  for (const [placeholder, original] of existingEntries) {
    if (!existingByOriginal.has(original)) existingByOriginal.set(original, placeholder);
    existingPlaceholders.set(foldCase(placeholder), { original });
    existingOriginals.add(foldCase(original));
  }

  for (const [, original] of additionEntries) {
    if (existingPlaceholders.has(foldCase(original))) throw ambiguousSessionMapError();
  }

  const occupied = new Set(
    [...existingEntries, ...additionEntries]
      .flat()
      .map(foldCase)
  );
  const rebasedEntries = [];
  let text = sanitizedText;

  for (const [placeholder, original] of additionEntries) {
    const existingPlaceholder = existingByOriginal.get(original);
    if (existingPlaceholder) {
      text = replaceExact(text, placeholder, existingPlaceholder);
      continue;
    }

    const foldedPlaceholder = foldCase(placeholder);
    const placeholderCollision = existingPlaceholders.get(foldedPlaceholder);
    let target = placeholder;
    if (
      existingOriginals.has(foldedPlaceholder) ||
      (placeholderCollision && placeholderCollision.original !== original)
    ) {
      target = allocatePrivatePlaceholder(placeholder, occupied);
      text = replaceExact(text, placeholder, target);
    }
    occupied.add(foldCase(target));
    rebasedEntries.push([target, original]);
  }

  return {
    sanitizedText: text,
    sessionMap: normalizeSessionMap(recordFromEntries(rebasedEntries))
  };
}

function isValidEntry([placeholder, original]) {
  return (
    typeof placeholder === "string" &&
    typeof original === "string" &&
    placeholder.length > 0 &&
    original.length > 0 &&
    placeholder !== original
  );
}

function validateEntries(entries) {
  const placeholders = new Map();
  const originals = new Map();

  for (const [placeholder, original] of entries) {
    const placeholderKey = foldCase(placeholder);
    if (UNSAFE_PLACEHOLDERS.has(placeholderKey)) throw invalidSessionMapError();
    rememberUnambiguous(placeholders, placeholderKey, placeholder);
    rememberUnambiguous(originals, foldCase(original), original);
  }

  for (const placeholderKey of placeholders.keys()) {
    if (originals.has(placeholderKey)) throw ambiguousSessionMapError();
  }
}

function assertCompatibleOriginals(existing, additions) {
  const originals = new Map();
  for (const original of [...Object.values(existing), ...Object.values(additions)]) {
    rememberUnambiguous(originals, foldCase(original), original);
  }
}

function rememberUnambiguous(index, key, value) {
  const existing = index.get(key);
  if (existing !== undefined && existing !== value) throw ambiguousSessionMapError();
  index.set(key, value);
}

function compareEntries([left], [right]) {
  return compareText(foldCase(left), foldCase(right)) || compareText(left, right);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function recordFromEntries(entries) {
  const record = {};
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return record;
}

function replaceExact(text, source, replacement) {
  return source === replacement ? text : text.split(source).join(replacement);
}

function allocatePrivatePlaceholder(placeholder, occupied) {
  const match = placeholder.match(/^\[([A-Z][A-Z0-9_]*)_(\d+)\]$/);
  const type = match?.[1] || inferPlaceholderType(placeholder);
  let index = match ? Number(match[2]) + 1 : 1;
  let candidate = `[${type}_${index}]`;
  while (occupied.has(foldCase(candidate))) {
    index += 1;
    candidate = `[${type}_${index}]`;
  }
  return candidate;
}

function inferPlaceholderType(placeholder) {
  if (/api|key|token|secret|credential/i.test(placeholder)) return "API_KEY";
  if (/email|@/i.test(placeholder)) return "EMAIL";
  if (/phone|555/i.test(placeholder)) return "PHONE";
  return "PRIVATE_VALUE";
}

function invalidSessionMapError() {
  const error = new Error("PrivacyAI blocked an unsafe session-map placeholder.");
  error.code = "PRIVACYAI_INVALID_SESSION_MAP";
  return error;
}

function ambiguousSessionMapError() {
  const error = new Error(
    "PrivacyAI blocked a session map with ambiguous case-insensitive aliases."
  );
  error.code = "PRIVACYAI_AMBIGUOUS_SESSION_MAP";
  return error;
}
