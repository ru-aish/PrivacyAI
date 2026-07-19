import { EXACT_TEXT_EDIT_PROMPT } from "./prompts.js";

const DEFAULT_MAX_EDITS = 256;
const DEFAULT_MAX_FRAGMENT_CHARS = 8192;
const DEFAULT_MAX_ANCHOR_CHARS = 2048;
const DEFAULT_WHOLE_DOCUMENT_THRESHOLD = 0.8;
const DEFAULT_WHOLE_DOCUMENT_MIN_CHARS = 256;

/**
 * Generate compact model-authored patches and apply them only after strict
 * exact-source verification. Works for code, prose, configuration, and other
 * plain text without asking the model to reproduce the completed document.
 */
export class TextEditGenerator {
  constructor(options = {}) {
    if (!options.provider || typeof options.provider.chat !== "function") {
      throw new TypeError("TextEditGenerator requires a provider with chat().");
    }
    this.provider = options.provider;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt || EXACT_TEXT_EDIT_PROMPT;
    this.maxTokens = options.maxTokens || 700;
  }

  async edit(source, instruction, options = {}) {
    if (typeof source !== "string") {
      throw new TypeError("TextEditGenerator.edit expects source to be a string.");
    }
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      throw new TypeError("TextEditGenerator.edit expects a non-empty instruction.");
    }

    const response = await this.provider.chat({
      model: options.model || this.model,
      messages: [
        { role: "system", content: options.systemPrompt || this.systemPrompt },
        { role: "user", content: JSON.stringify({ instruction, source }) }
      ],
      temperature: 0,
      maxTokens: options.maxTokens || this.maxTokens
    });
    const applied = parseAndApplyTextEdits(response.text, source, options);
    if (!applied) {
      const error = new Error(
        "PrivacyAI blocked a model edit response that did not contain valid exact-source patches."
      );
      error.code = "PRIVACYAI_INVALID_TEXT_EDITS";
      throw error;
    }

    return {
      originalText: source,
      text: applied.text,
      edits: applied.edits,
      modelText: response.text,
      provider: response.provider,
      rawProviderResponse: response.raw
    };
  }
}

/**
 * Apply compact exact-match edits against one immutable source string.
 *
 * Supported edit shapes:
 *   { search, replace, occurrence?, all?, before?, after? }
 *   { old_text, new_text, occurrence?, all?, before?, after? }
 *
 * `occurrence` is one-based. `all: true` applies the same compact replacement
 * to every exact match. Optional before/after anchors remain supported for
 * callers that prefer nearby context over an occurrence index.
 */
export function applyTextEdits(originalText, edits, options = {}) {
  if (typeof originalText !== "string") {
    throw new TypeError("applyTextEdits expects originalText to be a string.");
  }
  if (!Array.isArray(edits)) {
    throw editError("PRIVACYAI_INVALID_TEXT_EDITS", "Text edits must be an array.");
  }

  const maxEdits = positiveInteger(options.maxEdits, DEFAULT_MAX_EDITS, "maxEdits");
  const maxFragmentChars = positiveInteger(
    options.maxFragmentChars,
    DEFAULT_MAX_FRAGMENT_CHARS,
    "maxFragmentChars"
  );
  const maxAnchorChars = positiveInteger(
    options.maxAnchorChars,
    DEFAULT_MAX_ANCHOR_CHARS,
    "maxAnchorChars"
  );
  if (edits.length > maxEdits) {
    throw editError(
      "PRIVACYAI_TOO_MANY_TEXT_EDITS",
      `PrivacyAI blocked ${edits.length} text edits because the configured limit is ${maxEdits}.`
    );
  }

  const resolved = [];
  for (let index = 0; index < edits.length; index += 1) {
    const normalized = normalizeEdit(edits[index], index, maxFragmentChars, maxAnchorChars);
    if (normalized.oldText === normalized.newText) continue;
    assertNotWholeDocumentRewrite(originalText, normalized, options);

    const candidates = matchingOffsets(originalText, normalized);
    if (candidates.length === 0) {
      throw editError(
        "PRIVACYAI_TEXT_EDIT_NOT_FOUND",
        `PrivacyAI could not locate text edit ${index + 1} exactly in the original input.`
      );
    }

    if (normalized.all) {
      for (const start of candidates) resolved.push(resolveEdit(start, normalized));
      continue;
    }

    if (normalized.occurrence !== null) {
      const start = candidates[normalized.occurrence - 1];
      if (start === undefined) {
        throw editError(
          "PRIVACYAI_TEXT_EDIT_OCCURRENCE_NOT_FOUND",
          `PrivacyAI could not locate occurrence ${normalized.occurrence} for text edit ${index + 1}.`
        );
      }
      resolved.push(resolveEdit(start, normalized));
      continue;
    }

    if (candidates.length !== 1) {
      throw editError(
        "PRIVACYAI_AMBIGUOUS_TEXT_EDIT",
        `PrivacyAI blocked text edit ${index + 1} because it matched ${candidates.length} locations without an occurrence or exact anchors.`
      );
    }
    resolved.push(resolveEdit(candidates[0], normalized));
  }

  resolved.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index].start < resolved[index - 1].end) {
      throw editError(
        "PRIVACYAI_OVERLAPPING_TEXT_EDITS",
        "PrivacyAI blocked overlapping text edits."
      );
    }
  }

  let text = originalText;
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    const edit = resolved[index];
    if (text.slice(edit.start, edit.end) !== edit.oldText) {
      throw editError(
        "PRIVACYAI_TEXT_EDIT_SOURCE_CHANGED",
        "PrivacyAI blocked a text edit because its exact source fragment changed."
      );
    }
    text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
  }

  return { text, edits: resolved };
}

/** Parse a model JSON response and apply its compact edits locally. */
export function parseAndApplyTextEdits(modelText, originalText, options = {}) {
  const json = extractJsonObject(modelText);
  if (!json) return null;
  const edits = Array.isArray(json.edits)
    ? json.edits
    : Array.isArray(json.patches)
      ? json.patches
      : null;
  if (!edits) return null;

  try {
    const applied = applyTextEdits(originalText, edits, options);
    return { ...applied, json };
  } catch {
    return null;
  }
}

function normalizeEdit(value, index, maxFragmentChars, maxAnchorChars) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw editError(
      "PRIVACYAI_INVALID_TEXT_EDIT",
      `PrivacyAI blocked malformed text edit ${index + 1}.`
    );
  }

  const oldText = value.old_text ?? value.search;
  const newText = value.new_text ?? value.replace;
  const before = value.before ?? "";
  const after = value.after ?? "";
  const all = value.all === true;
  const occurrence = value.occurrence == null ? null : Number(value.occurrence);
  if (
    typeof oldText !== "string" ||
    oldText.length === 0 ||
    typeof newText !== "string" ||
    typeof before !== "string" ||
    typeof after !== "string" ||
    (value.all != null && typeof value.all !== "boolean") ||
    (occurrence !== null && (!Number.isSafeInteger(occurrence) || occurrence < 1))
  ) {
    throw editError(
      "PRIVACYAI_INVALID_TEXT_EDIT",
      `PrivacyAI blocked malformed text edit ${index + 1}.`
    );
  }
  if (oldText.length > maxFragmentChars || newText.length > maxFragmentChars) {
    throw editError(
      "PRIVACYAI_TEXT_EDIT_TOO_LARGE",
      `PrivacyAI blocked text edit ${index + 1} because a fragment exceeded ${maxFragmentChars} characters.`
    );
  }
  if (before.length > maxAnchorChars || after.length > maxAnchorChars) {
    throw editError(
      "PRIVACYAI_TEXT_EDIT_ANCHOR_TOO_LARGE",
      `PrivacyAI blocked text edit ${index + 1} because an anchor exceeded ${maxAnchorChars} characters.`
    );
  }

  return { oldText, newText, before, after, occurrence, all };
}

function matchingOffsets(text, edit) {
  const offsets = [];
  let searchFrom = 0;
  while (searchFrom <= text.length - edit.oldText.length) {
    const start = text.indexOf(edit.oldText, searchFrom);
    if (start === -1) break;
    const end = start + edit.oldText.length;
    const beforeMatches = !edit.before || text.slice(0, start).endsWith(edit.before);
    const afterMatches = !edit.after || text.slice(end).startsWith(edit.after);
    if (beforeMatches && afterMatches) offsets.push(start);
    searchFrom = start + Math.max(1, edit.oldText.length);
  }
  return offsets;
}

function resolveEdit(start, edit) {
  return {
    start,
    end: start + edit.oldText.length,
    oldText: edit.oldText,
    newText: edit.newText,
    before: edit.before,
    after: edit.after,
    occurrence: edit.occurrence,
    all: edit.all
  };
}

function assertNotWholeDocumentRewrite(originalText, edit, options) {
  const threshold = Number(
    options.wholeDocumentThreshold ?? DEFAULT_WHOLE_DOCUMENT_THRESHOLD
  );
  const minChars = positiveInteger(
    options.wholeDocumentMinChars,
    DEFAULT_WHOLE_DOCUMENT_MIN_CHARS,
    "wholeDocumentMinChars"
  );
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new TypeError("wholeDocumentThreshold must be greater than 0 and at most 1.");
  }
  if (
    originalText.length >= minChars &&
    edit.oldText.length >= originalText.length * threshold
  ) {
    throw editError(
      "PRIVACYAI_WHOLE_DOCUMENT_EDIT",
      "PrivacyAI blocked an edit that attempted to replace most of the input instead of returning a compact patch."
    );
  }
}

function extractJsonObject(text) {
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function positiveInteger(value, fallback, name) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return normalized;
}

function editError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
