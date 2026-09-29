export const PRIVACY_PLACEHOLDER_CONTRACT_VERSION = 1;

export const CANONICAL_PRIVACY_PLACEHOLDER_PATTERN_SOURCE =
  String.raw`\[PAI1_([A-Z][A-Z0-9_]{0,63})_([A-F0-9]{24,64})\]`;

const CANONICAL_PLACEHOLDER_PATTERN = new RegExp(
  `^${CANONICAL_PRIVACY_PLACEHOLDER_PATTERN_SOURCE}$`
);
const LEGACY_PLACEHOLDER_PATTERN = /^\[([A-Z][A-Z0-9_]{0,63})_(\d{1,10})\]$/i;
const CANONICAL_PREFIX_PATTERN = /^\[PAI\d*_/i;

export function normalizePrivacyCategory(value, fallback = "PRIVATE_VALUE") {
  const normalized = String(value || fallback)
    .normalize("NFKC")
    .toLocaleUpperCase("en-US")
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : fallback;
}

export function formatPrivacyPlaceholder(value) {
  const category = normalizePrivacyCategory(value?.category);
  const digest = String(value?.digest || "").toLocaleUpperCase("en-US");
  if (!/^[A-F0-9]{24,64}$/.test(digest)) {
    throw placeholderError(
      "PRIVACYAI_INVALID_PLACEHOLDER_DIGEST",
      "Canonical PrivacyAI placeholders require 24 to 64 hexadecimal digest characters."
    );
  }
  return `[PAI1_${category}_${digest}]`;
}

export function parsePrivacyPlaceholder(value, options = {}) {
  if (typeof value !== "string" || value.length === 0) return null;

  const canonical = CANONICAL_PLACEHOLDER_PATTERN.exec(value);
  if (canonical) {
    return Object.freeze({
      format: "canonical",
      version: PRIVACY_PLACEHOLDER_CONTRACT_VERSION,
      category: canonical[1],
      digest: canonical[2].toLocaleLowerCase("en-US"),
      alias: value
    });
  }

  if (options.allowLegacy === false) return null;
  const legacy = LEGACY_PLACEHOLDER_PATTERN.exec(value);
  if (!legacy) return null;
  const ordinal = Number(legacy[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) return null;
  return Object.freeze({
    format: "legacy",
    version: 0,
    category: normalizePrivacyCategory(legacy[1]),
    ordinal,
    alias: value
  });
}

export function validatePrivacyPlaceholder(value, options = {}) {
  const parsed = parsePrivacyPlaceholder(value, options);
  if (parsed) return parsed;
  throw placeholderError(
    "PRIVACYAI_INVALID_PLACEHOLDER",
    "PrivacyAI received a malformed placeholder."
  );
}

export function isCanonicalPrivacyPlaceholder(value) {
  return parsePrivacyPlaceholder(value, { allowLegacy: false }) != null;
}

export function looksLikeMalformedCanonicalPlaceholder(value) {
  return typeof value === "string" &&
    CANONICAL_PREFIX_PATTERN.test(value) &&
    !isCanonicalPrivacyPlaceholder(value);
}

export function privacyCategoryFromAlias(alias, fallback = "PRIVATE_VALUE") {
  return parsePrivacyPlaceholder(alias)?.category || normalizePrivacyCategory(fallback);
}

export function allocateLegacyPlaceholderAlias(placeholder, occupied) {
  const normalizedOccupied = occupied instanceof Set ? occupied : new Set(occupied || []);
  const parsed = parsePrivacyPlaceholder(placeholder);
  const type = parsed?.category || inferPlaceholderType(placeholder);
  let index = parsed?.format === "legacy" ? parsed.ordinal + 1 : 1;
  let candidate = `[${type}_${index}]`;
  while (normalizedOccupied.has(foldAlias(candidate))) {
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

function foldAlias(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("und");
}

function placeholderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
