export function estimatePrivacyTokens(text, tokenCounter) {
  const source = String(text ?? "");
  if (typeof tokenCounter === "function") {
    const exact = tokenCounter(source);
    if (!Number.isSafeInteger(exact) || exact < 0) {
      throw new TypeError("tokenCounter must synchronously return a non-negative safe integer.");
    }
    return exact;
  }
  if (!source) return 0;

  let tokens = 0;
  const runs = source.match(/\s+|[A-Za-z]+|\d+|[^\x00-\x7F]|[^A-Za-z\d\s]/gu) || [];
  for (const run of runs) {
    if (/^\s+$/u.test(run)) {
      tokens += Math.max(1, Math.ceil(run.length / 4));
    } else if (/^[A-Za-z]+$/u.test(run)) {
      // Identifiers and prose words usually compress, but long code symbols do
      // not consistently reach the common four-characters-per-token ratio.
      tokens += Math.max(1, Math.ceil(run.length / 3));
    } else if (/^\d+$/u.test(run)) {
      tokens += Math.max(1, Math.ceil(run.length / 2));
    } else if (/^[^\x00-\x7F]+$/u.test(run)) {
      // Count Unicode code points conservatively; emoji and combining scripts
      // can consume multiple tokenizer pieces.
      tokens += Math.max(1, [...run].length * 2);
    } else {
      // JSON/code punctuation is frequently one token per symbol.
      tokens += [...run].length;
    }
  }
  return Math.max(1, tokens);
}

export function normalizeTokenBudget(value, fallback) {
  const tokens = value == null ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new TypeError("maxContextTokens must be a positive safe integer.");
  }
  return tokens;
}
