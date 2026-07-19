import { replaceKnownText } from "./placeholder-transform.js";
import { normalizeSessionMap } from "./session-map-contract.js";
import { MAX_PRIVATE_SPAN_CHARS } from "./structured-chunks.js";
import { escapeRegExp, foldCase } from "./text-matching.js";

export function shieldKnownValues(text, sessionMap) {
  const replacements = [];
  const occupied = [text, ...Object.keys(sessionMap), ...Object.values(sessionMap)]
    .map(foldCase);
  let tokenIndex = 0;

  const shielded = replaceKnownText(text, sessionMap, ({ match }) => {
    let token;
    let foldedToken;
    do {
      token = `__PRIVACYAI_BOUNDARY_${tokenIndex}__`;
      tokenIndex += 1;
      foldedToken = foldCase(token);
    } while (occupied.some(value => value.includes(foldedToken)));
    occupied.push(foldedToken);
    replacements.push({ token, source: match });
    return token;
  });

  const foldedTokens = replacements.map(({ token }) => foldCase(token));
  const exactTokens = new Set(foldedTokens);
  return {
    text: shielded,
    isToken(value) {
      return typeof value === "string" && exactTokens.has(foldCase(value));
    },
    containsToken(value) {
      if (typeof value !== "string") return false;
      const folded = foldCase(value);
      return foldedTokens.some(token => folded.includes(token));
    },
    restoreSource(value) {
      if (typeof value !== "string") return value;
      let restored = value;
      for (const { token, source } of replacements) {
        restored = restored.replace(new RegExp(escapeRegExp(token), "gi"), () => source);
      }
      return restored;
    }
  };
}

export function recoverClassifierAdditions(inputText, classifierMap, shield) {
  const entries = [];
  for (const [placeholder, original] of Object.entries(classifierMap)) {
    if (shield.containsToken(placeholder)) throw reservedBoundaryError();
    if (shield.isToken(original)) continue;

    const restoredOriginal = shield.restoreSource(original);
    assertBoundedExactSpan(restoredOriginal);
    if (inputText.includes(restoredOriginal)) entries.push([placeholder, restoredOriginal]);
  }
  return normalizeSessionMap(Object.fromEntries(entries));
}

function assertBoundedExactSpan(original) {
  if (
    typeof original !== "string" ||
    original.length === 0 ||
    original.length > MAX_PRIVATE_SPAN_CHARS ||
    /\r|\n/.test(original)
  ) {
    const error = new Error(
      "PrivacyAI blocked a local classifier result that did not identify a bounded exact substring."
    );
    error.code = "PRIVACYAI_INVALID_CLASSIFIER_SPAN";
    throw error;
  }
}

function reservedBoundaryError() {
  const error = new Error(
    "PrivacyAI blocked a local classifier result that reused a reserved boundary token."
  );
  error.code = "PRIVACYAI_INVALID_SANITIZED_CONTEXT";
  return error;
}
