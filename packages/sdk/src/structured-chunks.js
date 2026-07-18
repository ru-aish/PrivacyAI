export const MAX_PRIVATE_SPAN_CHARS = 512;

const MIN_SAFE_CHUNK_CHARS = MAX_PRIVATE_SPAN_CHARS * 2;
const BATCH_OVERHEAD_CHARS = 128;

export function buildStructuredBatches(
  slots,
  { maxContextChars, maxContextTokens, countTokens }
) {
  assertSafeClassifierWindow(maxContextChars, maxContextTokens, countTokens);
  const units = buildUnits(
    slots,
    maxContextChars,
    maxContextTokens,
    countTokens
  );
  return {
    unitCount: units.length,
    batches: packUnits(units, maxContextChars, maxContextTokens)
  };
}

export function encodeBatch(batch) {
  return batch.map(unit => `${unitHeader(unit)}${unit.text}`).join("");
}

export function contextWindowError(maxChars, maxTokens) {
  const error = new Error(
    `PrivacyAI cannot safely overlap private spans inside a ${maxChars}-character/${maxTokens}-token classifier window.`
  );
  error.code = "PRIVACYAI_CONTEXT_TOO_LARGE";
  return error;
}

function assertSafeClassifierWindow(maxChars, maxTokens, countTokens) {
  if (maxChars <= MIN_SAFE_CHUNK_CHARS + BATCH_OVERHEAD_CHARS) {
    throw contextWindowError(maxChars, maxTokens);
  }
  const probe = `${unitHeader({ slotIndex: 0, chunkIndex: 0 })}${"!".repeat(MIN_SAFE_CHUNK_CHARS)}`;
  if (countTokens(probe) > maxTokens) throw contextWindowError(maxChars, maxTokens);
}

function buildUnits(slots, maxChars, maxTokens, countTokens) {
  const units = [];
  slots.forEach((slot, slotIndex) => {
    const chunks = splitText(slot.value, slotIndex, maxChars, maxTokens, countTokens);
    chunks.forEach((text, chunkIndex) => {
      const unit = { slotIndex, chunkIndex, text };
      unit.encodedChars = unitHeader(unit).length + text.length;
      unit.estimatedTokens = countTokens(`${unitHeader(unit)}${text}`);
      if (unit.encodedChars > maxChars || unit.estimatedTokens > maxTokens) {
        throw contextWindowError(maxChars, maxTokens);
      }
      units.push(unit);
    });
  });
  return units;
}

function packUnits(units, maxChars, maxTokens) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  let currentTokens = 0;

  for (const unit of units) {
    const exceedsWindow =
      currentChars + unit.encodedChars > maxChars ||
      currentTokens + unit.estimatedTokens > maxTokens;
    if (current.length > 0 && exceedsWindow) {
      batches.push(current);
      current = [];
      currentChars = 0;
      currentTokens = 0;
    }
    current.push(unit);
    currentChars += unit.encodedChars;
    currentTokens += unit.estimatedTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function splitText(text, slotIndex, maxChars, maxTokens, countTokens) {
  const chunks = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < text.length || (text.length === 0 && chunkIndex === 0)) {
    const header = unitHeader({ slotIndex, chunkIndex });
    const hardEnd = Math.min(text.length, start + Math.max(1, maxChars - header.length));
    let end = largestFittingEnd(text, start, hardEnd, header, maxTokens, countTokens);
    if (end <= start && text.length > 0) throw contextWindowError(maxChars, maxTokens);

    if (end < text.length) {
      const boundary = preferredBoundary(text, start, end);
      if (boundary - start >= MIN_SAFE_CHUNK_CHARS) end = boundary;
    }
    end = avoidBrokenSurrogate(text, start, end);
    if (end < text.length && end - start < MIN_SAFE_CHUNK_CHARS) {
      throw contextWindowError(maxChars, maxTokens);
    }

    const chunk = text.slice(start, end);
    if (header.length + chunk.length > maxChars || countTokens(`${header}${chunk}`) > maxTokens) {
      throw contextWindowError(maxChars, maxTokens);
    }
    chunks.push(chunk);
    chunkIndex += 1;
    if (end >= text.length) break;

    // One complete maximum private span remains visible on both sides of every
    // boundary, while each non-final window still advances by at least one span.
    start = end - MAX_PRIVATE_SPAN_CHARS;
  }
  return chunks;
}

function largestFittingEnd(text, start, hardEnd, header, maxTokens, countTokens) {
  let low = start;
  let high = hardEnd;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(`${header}${text.slice(start, middle)}`) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return low;
}

function avoidBrokenSurrogate(text, start, end) {
  if (end <= start || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const splitsPair =
    previous >= 0xd800 && previous <= 0xdbff &&
    next >= 0xdc00 && next <= 0xdfff;
  return splitsPair ? end - 1 : end;
}

function preferredBoundary(text, start, hardEnd) {
  const minimum = start + Math.floor((hardEnd - start) * 0.65);
  const window = text.slice(minimum, hardEnd);
  const newline = window.lastIndexOf("\n");
  if (newline !== -1) return minimum + newline + 1;
  const whitespace = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
  return whitespace === -1 ? hardEnd : minimum + whitespace + 1;
}

function unitHeader({ slotIndex, chunkIndex }) {
  return `\n__PRIVACYAI_SLOT_${slotIndex}_${chunkIndex}__\n`;
}
