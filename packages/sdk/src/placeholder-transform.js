import { normalizeSessionMap } from "./session-map-contract.js";
import { transformValue } from "./structured-value.js";
import { escapeRegExp, foldCase } from "./text-matching.js";

export function restoreText(text, sessionMap = {}) {
  if (typeof text !== "string") return text;
  return compileTextRestorer(sessionMap)(text);
}

export function sanitizeKnownText(text, sessionMap = {}) {
  if (typeof text !== "string") return text;
  return compileKnownSanitizer(sessionMap)(text);
}

export function replaceKnownText(text, sessionMap = {}, replacer) {
  if (typeof text !== "string") return text;
  return compileKnownReplacer(sessionMap, replacer)(text);
}

export function restoreValue(value, sessionMap = {}, options = {}) {
  return transformValue(value, lazyTransformer(() => compileTextRestorer(sessionMap)), options);
}

export function sanitizeKnownValue(value, sessionMap = {}, options = {}) {
  return transformValue(value, lazyTransformer(() => compileKnownSanitizer(sessionMap)), options);
}

export function compileTextRestorer(sessionMap = {}) {
  return compileNormalizedTextRestorer(normalizeSessionMap(sessionMap));
}

export function compileNormalizedTextRestorer(sessionMap) {
  const entries = Object.entries(sessionMap)
    .sort(([left], [right]) => right.length - left.length || compareText(left, right));
  if (entries.length === 0) return identityText;

  const originals = new Map(entries);
  const pattern = new RegExp(
    entries.map(([placeholder]) => escapeRegExp(placeholder)).join("|"),
    "g"
  );
  return text => text.replace(pattern, placeholder => originals.get(placeholder));
}

export function compileKnownSanitizer(sessionMap = {}) {
  return compileKnownReplacer(sessionMap, ({ match, candidate }) =>
    candidate.kind === "placeholder" ? match : candidate.placeholder
  );
}

export function compileKnownReplacer(sessionMap = {}, replacer) {
  if (typeof replacer !== "function") {
    throw new TypeError("replaceKnownText requires a replacement callback.");
  }

  const candidates = replacementCandidates(normalizeSessionMap(sessionMap));
  if (candidates.length === 0) return identityText;
  const candidatesByValue = new Map(
    candidates.map(candidate => [foldCase(candidate.value), candidate])
  );
  const pattern = new RegExp(
    candidates.map(candidate => escapeRegExp(candidate.value)).join("|"),
    "gi"
  );

  // Match only the original input. Replacement output is never rescanned, so
  // protected originals cannot rewrite text inside existing or inserted tokens.
  return text => text.replace(pattern, match => {
    const candidate = candidatesByValue.get(foldCase(match));
    if (!candidate) {
      throw new Error("PrivacyAI could not resolve a known-value replacement.");
    }
    return String(replacer({ match, candidate }));
  });
}

function replacementCandidates(sessionMap) {
  const entries = Object.entries(sessionMap);
  const candidates = entries.map(([placeholder]) => ({
    kind: "placeholder",
    value: placeholder,
    placeholder
  }));
  const originals = new Set();
  for (const [placeholder, original] of entries) {
    if (originals.has(original)) continue;
    originals.add(original);
    candidates.push({ kind: "original", value: original, placeholder });
  }

  return candidates.sort((left, right) =>
    right.value.length - left.value.length ||
    Number(left.kind !== "placeholder") - Number(right.kind !== "placeholder") ||
    compareText(foldCase(left.value), foldCase(right.value)) ||
    compareText(left.value, right.value)
  );
}

function lazyTransformer(compile) {
  let transform;
  return text => {
    transform ||= compile();
    return transform(text);
  };
}

function identityText(text) {
  return text;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
