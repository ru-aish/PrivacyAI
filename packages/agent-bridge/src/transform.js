import { restore as restoreSdkText } from "@privacy-ai/sdk";

const DEFAULT_PLACEHOLDER_PATTERN =
  /\[[A-Z][A-Z0-9_]*_\d+\]|gsk_dummy_\d+_redacted|AKIADUMMY\d+KEY|contact\d+@example\.com|redacted_secret_\d+|credential_\d+|SensitiveValue\d+/g;

export function restoreText(text, sessionMap = {}) {
  if (typeof text !== "string") return text;
  return restoreSdkText(text, sessionMap);
}

export function sanitizeKnownText(text, sessionMap = {}) {
  if (typeof text !== "string") return text;

  let sanitized = text;
  const replacements = Object.entries(sessionMap)
    .filter(([dummy, original]) => typeof dummy === "string" && typeof original === "string" && dummy && original)
    .sort((left, right) => right[1].length - left[1].length);

  for (const [dummy, original] of replacements) {
    sanitized = sanitized.split(original).join(dummy);
  }

  return sanitized;
}

export function transformValue(value, transformText) {
  if (typeof value === "string") return transformText(value);
  if (Array.isArray(value)) return value.map(item => transformValue(item, transformText));

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, transformValue(item, transformText)])
    );
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
  const matches = new Set();
  transformValue(value, text => {
    const localPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(localPattern)) matches.add(match[0]);
    return text;
  });
  return [...matches];
}

export function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
