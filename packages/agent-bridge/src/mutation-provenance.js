import { createHash } from "node:crypto";

/**
 * Ledger-facing mutation provenance. This module deliberately receives proof
 * from tool boundaries; it does not inspect shell commands or retain file
 * text. Current Codex/AGY request APIs do not expose a successful filesystem
 * result with an expected hash, so callers must use these primitives there.
 */
export function normalizeFileMutationOperation(operation = {}) {
  const type = String(operation.type || operation.kind || "");
  if (!new Set(["apply_patch", "write_file", "replace_in_file"]).has(type)) {
    throw new TypeError("mutation operation type must be apply_patch, write_file, or replace_in_file.");
  }
  const edits = type === "write_file" ? [] : normalizeEdits(operation.edits || [operation]);
  return {
    type,
    editCount: edits.length,
    edits: edits.map(edit => ({ start: edit.start, end: edit.end, insertedLength: edit.insertedLength })),
    byteLength: optionalNonNegative(operation.byteLength ?? operation.nextByteLength)
  };
}

export function stageProvenancedMutation(store, record) {
  requireStore(store);
  const operation = normalizeFileMutationOperation(record.operation);
  const mutationId = opaqueId(record.mutationId || fingerprint({
    worktreeId: record.worktreeId,
    pathHash: record.pathHash,
    expectedContentHash: record.expectedContentHash,
    nextContentHash: record.nextContentHash,
    operation
  }));
  const operationHash = fingerprint(operation);
  return store.stageFileMutation({
    mutationId,
    worktreeId: opaqueId(record.worktreeId),
    pathHash: opaqueId(record.pathHash),
    expectedContentHash: opaqueId(record.expectedContentHash),
    nextContentHash: opaqueId(record.nextContentHash),
    manifestHash: record.manifestHash == null ? undefined : opaqueId(record.manifestHash),
    // This is an opaque hash of compact geometry only, never edit text.
    opaqueReference: operationHash
  });
}

export function commitProvenancedMutation(store, mutationId, actualContentHash, options = {}) {
  requireStore(store);
  const id = opaqueId(mutationId);
  const existing = store.getFileMutation(id);
  if (existing?.status === "committed") {
    return existing.nextContentHash === actualContentHash ? existing : { status: "mismatch", expectedContentHash: existing.nextContentHash };
  }
  if (options.cancelled || options.success !== true) return store.rollbackFileMutation(id);
  const result = store.commitFileMutation(id, opaqueId(actualContentHash), options.committedReference == null ? undefined : opaqueId(options.committedReference));
  // A hash mismatch is not reusable pending work: remove it from reuse.
  if (result.status === "mismatch") return store.rollbackFileMutation(id);
  return result;
}

export function rollbackProvenancedMutation(store, mutationId) {
  requireStore(store);
  return store.rollbackFileMutation(opaqueId(mutationId));
}

/** Reconcile an externally observed content transition without guessing its cause. */
export function reconcileExternalFileChange(store, record) {
  requireStore(store);
  const oldContentHash = opaqueId(record.oldContentHash);
  const newContentHash = opaqueId(record.newContentHash);
  if (oldContentHash === newContentHash) return { status: "unchanged", oldContentHash, newContentHash };
  return {
    status: "changed",
    oldContentHash,
    newContentHash,
    previousPlan: record.policyFingerprint ? store.getPrivacyPlan(oldContentHash, record.policyFingerprint) : undefined
  };
}

/** Pure propagation for ordered, non-overlapping exact edits. */
export function propagatePrivacySpans(spans, edits, options = {}) {
  const sourceLength = requiredNonNegative(options.sourceLength, "sourceLength");
  const overlap = optionalNonNegative(options.overlap ?? 64) ?? 64;
  const normalizedEdits = normalizeEdits(edits);
  validateOrderedEdits(normalizedEdits, sourceLength);
  const output = [];
  const rescans = [];
  for (const span of normalizeSpans(spans, sourceLength)) {
    let shift = 0;
    let invalid = false;
    for (const edit of normalizedEdits) {
      if (span.end <= edit.start) break;
      if (span.start >= edit.end) { shift += edit.insertedLength - (edit.end - edit.start); continue; }
      invalid = true;
      break;
    }
    if (!invalid) output.push({ ...span, start: span.start + shift, end: span.end + shift });
  }
  let shift = 0;
  for (const edit of normalizedEdits) {
    const nextStart = edit.start + shift;
    const nextEnd = nextStart + edit.insertedLength;
    for (const insertion of edit.knownInsertions) {
      output.push({
        start: nextStart + insertion.offset,
        end: nextStart + insertion.offset + insertion.length,
        classification: insertion.classification,
        reference: insertion.reference
      });
    }
    rescans.push({ start: Math.max(0, nextStart - overlap), end: nextEnd + overlap });
    shift += edit.insertedLength - (edit.end - edit.start);
  }
  const nextLength = sourceLength + shift;
  return {
    spans: output.sort((a, b) => a.start - b.start || a.end - b.end || a.reference.localeCompare(b.reference)),
    rescanRanges: mergeRanges(rescans, nextLength),
    nextLength
  };
}

function normalizeEdits(edits) {
  if (!Array.isArray(edits)) throw new TypeError("mutation edits must be an array.");
  return edits.map(edit => {
    const start = requiredNonNegative(edit?.start, "edit start");
    const end = requiredNonNegative(edit?.end, "edit end");
    if (end < start) throw new TypeError("edit end must not precede start.");
    const insertedLength = requiredNonNegative(edit.insertedLength ?? edit.replacementLength ?? String(edit.replacement ?? edit.newText ?? "").length, "insertedLength");
    const knownInsertions = (edit.knownInsertions || []).map(value => ({
      offset: requiredNonNegative(value.offset ?? 0, "known insertion offset"),
      length: requiredNonNegative(value.length, "known insertion length"),
      classification: String(value.classification || "opaque_reference"),
      reference: opaqueId(value.reference)
    }));
    if (knownInsertions.some(value => value.offset + value.length > insertedLength)) throw new TypeError("known insertion exceeds inserted text.");
    return { start, end, insertedLength, knownInsertions };
  });
}

function validateOrderedEdits(edits, sourceLength) {
  let previousEnd = 0;
  for (const edit of edits) {
    if (edit.end > sourceLength || edit.start < previousEnd) throw new TypeError("edits must be ordered, non-overlapping source ranges.");
    previousEnd = edit.end;
  }
}

function normalizeSpans(spans, sourceLength) {
  if (!Array.isArray(spans)) throw new TypeError("spans must be an array.");
  return spans.map(span => {
    const start = requiredNonNegative(span?.start, "span start");
    const end = requiredNonNegative(span?.end, "span end");
    if (end < start || end > sourceLength) throw new TypeError("span must be within source length.");
    return { start, end, classification: String(span.classification || "opaque_reference"), reference: opaqueId(span.reference) };
  });
}

function mergeRanges(ranges, max) {
  const sorted = ranges.map(range => ({ start: Math.max(0, Math.min(max, range.start)), end: Math.max(0, Math.min(max, range.end)) }))
    .filter(range => range.end >= range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const output = [];
  for (const range of sorted) {
    const last = output.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else output.push(range);
  }
  return output;
}

function fingerprint(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function opaqueId(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{6,}$/i.test(value)) throw new TypeError("mutation provenance requires opaque sha256 identifiers.");
  return value;
}
function requiredNonNegative(value, label) { const normalized = Number(value); if (!Number.isSafeInteger(normalized) || normalized < 0) throw new TypeError(`${label} must be a non-negative safe integer.`); return normalized; }
function optionalNonNegative(value) { return value == null ? undefined : requiredNonNegative(value, "value"); }
function requireStore(store) { if (!store || typeof store.stageFileMutation !== "function") throw new TypeError("mutation provenance requires a ledger store."); }
