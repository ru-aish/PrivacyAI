import { GENERATED_DUMMY_PATTERN_SOURCE } from "./dummy-data.js";
import { CANONICAL_PRIVACY_PLACEHOLDER_PATTERN_SOURCE } from "./placeholder-identity.js";
import { normalizeSessionMap } from "./session-map-contract.js";
import { visitText } from "./structured-value.js";
import { escapeRegExp, foldCase } from "./text-matching.js";

const DEFAULT_PLACEHOLDER_PATTERN = new RegExp(
  String.raw`(?:${CANONICAL_PRIVACY_PLACEHOLDER_PATTERN_SOURCE}|\[[A-Z][A-Z0-9_]*_\d+\]|${GENERATED_DUMMY_PATTERN_SOURCE})`,
  "gi"
);

export function findUnresolvedPlaceholders(value, pattern = DEFAULT_PLACEHOLDER_PATTERN) {
  const source = placeholderPatternSource(pattern);
  const baseFlags = pattern && typeof pattern.flags === "string" ? pattern.flags : "";
  const flags = baseFlags.includes("g") ? baseFlags : `${baseFlags}g`;
  const matcher = new RegExp(source, flags);
  const matches = new Set();

  visitText(value, text => {
    matcher.lastIndex = 0;
    for (const match of text.matchAll(matcher)) matches.add(match[0]);
  });
  return [...matches];
}

export function assertNoProtectedOriginals(serializedPayload, sessionMap = {}) {
  if (typeof serializedPayload !== "string") {
    throw new TypeError("Provider-bound payload must be serialized text.");
  }
  const scanner = createLeakScanner(normalizeSessionMap(sessionMap));
  scanner.scan(serializedPayload);
  scanner.assertSafe();
}

export function assertNoProtectedOriginalsInValue(value, sessionMap = {}, options = {}) {
  const scanner = createLeakScanner(normalizeSessionMap(sessionMap));
  visitText(value, scanner.scan, options);
  scanner.assertSafe();
}

function placeholderPatternSource(pattern) {
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
  return source;
}

function createLeakScanner(sessionMap) {
  const placeholders = Object.keys(sessionMap)
    .sort((left, right) => right.length - left.length);
  const placeholderPattern = placeholders.length > 0
    ? new RegExp(placeholders.map(escapeRegExp).join("|"), "gi")
    : null;
  const originals = Object.values(sessionMap)
    .map(original => ({ original, folded: foldCase(original) }));
  const leaks = new Set();

  return {
    scan(text) {
      let searchableText = foldCase(text);
      if (placeholderPattern) {
        placeholderPattern.lastIndex = 0;
        searchableText = searchableText.replace(
          placeholderPattern,
          match => " ".repeat(match.length)
        );
      }
      for (const { original, folded } of originals) {
        if (searchableText.includes(folded)) leaks.add(original);
      }
    },
    assertSafe() {
      if (leaks.size > 0) throw providerPayloadLeakError(leaks.size);
    }
  };
}

function providerPayloadLeakError(leakCount) {
  const error = new Error(
    `PrivacyAI blocked provider-bound context because ${leakCount} protected value(s) remained.`
  );
  error.code = "PRIVACYAI_PROVIDER_PAYLOAD_LEAK";
  error.leakCount = leakCount;
  return error;
}
