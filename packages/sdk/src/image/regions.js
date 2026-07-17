import { createImageError } from "./errors.js";
import { expandBox, overlapOverMinimum, unionBoxes } from "./geometry.js";

export const DEFAULT_MASK_STRATEGIES = Object.freeze(["exact", "line", "block"]);
const ALLOWED_MASK_STRATEGIES = new Set(DEFAULT_MASK_STRATEGIES);

export function locatePrivateRegions(lines, sessionMap) {
  const candidates = Object.entries(sessionMap || {})
    .filter(([placeholder, original]) =>
      typeof placeholder === "string" && placeholder.length > 0 &&
      typeof original === "string" && original.length > 0 && placeholder !== original
    )
    .sort((left, right) =>
      right[1].length - left[1].length ||
      left[1].localeCompare(right[1]) ||
      left[0].localeCompare(right[0])
    );
  const regions = [];

  for (const line of lines || []) {
    const text = String(line.text || "");
    const lowerText = text.toLocaleLowerCase("en-US");
    const occupied = [];
    for (const [placeholder, original] of candidates) {
      const lowerOriginal = original.toLocaleLowerCase("en-US");
      let cursor = 0;
      while (cursor <= text.length - original.length) {
        const start = lowerText.indexOf(lowerOriginal, cursor);
        if (start === -1) break;
        const end = start + original.length;
        cursor = end;
        if (occupied.some(range => start < range.end && end > range.start)) continue;
        const words = (line.words || []).filter(word => word.start < end && word.end > start);
        regions.push({
          box: words.length > 0 ? unionBoxes(words.map(word => word.box)) : line.box,
          lineBox: line.box,
          placeholder,
          original,
          confidence: line.confidence || 0,
          fallback: words.length === 0
        });
        occupied.push({ start, end });
      }
    }
  }
  return dedupeRegions(regions);
}

export function normalizeMaskStrategies(value) {
  const strategies = value == null ? [...DEFAULT_MASK_STRATEGIES] : [...value];
  if (
    strategies.length === 0 ||
    strategies.some(strategy => !ALLOWED_MASK_STRATEGIES.has(strategy)) ||
    new Set(strategies).size !== strategies.length
  ) {
    throw new TypeError("maskStrategies must contain unique exact, line, or block strategies.");
  }
  return strategies;
}

export function regionsForStrategy(regions, strategy) {
  if (!ALLOWED_MASK_STRATEGIES.has(strategy)) {
    throw new TypeError(`Unsupported image mask strategy: ${strategy}`);
  }
  if (strategy === "exact") return regions.map(region => ({ ...region }));

  return dedupeRegions(regions.map(region => {
    const lineBox = region.lineBox || expandBox(region.box, 12, 8);
    if (strategy === "line") return { ...region, box: expandBox(lineBox, 6, 5) };

    const lineHeight = Math.max(1, lineBox[3] - lineBox[1]);
    const padding = Math.max(24, Math.ceil(lineHeight * 0.75));
    return { ...region, box: expandBox(lineBox, padding, padding) };
  }));
}

export function verifyPrivateTextRemoved(lines, regions) {
  const text = (lines || []).map(line => line.text).join("\n");
  const foldedText = foldCase(text);
  const compact = normalizeOcrText(text);
  const leaked = [...new Set(regions.map(region => region.original))].find(original => {
    const foldedOriginal = foldCase(original);
    const normalized = normalizeOcrText(original);
    return foldedText.includes(foldedOriginal) ||
      ([...normalized].length >= 4 && compact.includes(normalized));
  });
  if (leaked) {
    throw createImageError(
      "PRIVACYAI_IMAGE_VERIFICATION_FAILED",
      "PrivacyAI could not verify removal of private image text."
    );
  }
}

function dedupeRegions(regions) {
  const kept = [];
  for (const region of regions.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const duplicate = kept.find(current =>
      current.placeholder === region.placeholder && overlapOverMinimum(current.box, region.box) >= 0.55
    );
    if (!duplicate) kept.push({ ...region });
    else {
      duplicate.box = unionBoxes([duplicate.box, region.box]);
      if (region.lineBox) {
        duplicate.lineBox = duplicate.lineBox
          ? unionBoxes([duplicate.lineBox, region.lineBox])
          : region.lineBox;
      }
    }
  }
  return kept;
}

function foldCase(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("und");
}

function normalizeOcrText(value) {
  return foldCase(value).replace(/[^\p{L}\p{N}]/gu, "");
}
