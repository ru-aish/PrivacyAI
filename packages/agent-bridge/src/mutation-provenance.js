import { createHash } from "node:crypto";

const MUTATION_TYPES = new Set([
  "apply_patch",
  "write_file",
  "replace_in_file"
]);

/**
 * Convert a known file operation into compact, text-free geometry.
 * Raw replacement text may be inspected for its length, but is never returned.
 */
export function normalizeFileMutationOperation(operation = {}) {
  const type = String(operation.type || operation.kind || "");
  if (!MUTATION_TYPES.has(type)) {
    throw new TypeError(
      "mutation operation type must be apply_patch, write_file, or replace_in_file."
    );
  }

  const sourceLength = optionalNonNegative(operation.sourceLength);
  const nextLength = optionalNonNegative(
    operation.nextLength ?? operation.byteLength ?? operation.nextByteLength
  );

  let edits;
  if (type === "write_file") {
    edits = sourceLength != null && nextLength != null
      ? [{
          start: 0,
          end: sourceLength,
          insertedLength: nextLength,
          knownInsertions: normalizeInsertions(
            operation.knownInsertions || [],
            nextLength
          )
        }]
      : [];
  } else {
    edits = normalizeEdits(operation.edits || [operation], sourceLength);
  }

  if (
    sourceLength != null &&
    nextLength != null &&
    resultingLength(sourceLength, edits) !== nextLength
  ) {
    throw new TypeError("nextLength does not match mutation geometry.");
  }

  return {
    type,
    editCount: edits.length,
    edits,
    sourceLength,
    nextLength,
    fullWrite: type === "write_file" && edits.length === 0
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

  return store.stageFileMutation({
    mutationId,
    worktreeId: opaqueId(record.worktreeId),
    pathHash: opaqueId(record.pathHash),
    expectedContentHash: opaqueId(record.expectedContentHash),
    nextContentHash: opaqueId(record.nextContentHash),
    manifestHash: record.manifestHash == null
      ? undefined
      : opaqueId(record.manifestHash),
    opaqueReference: fingerprint(operation),
    operationType: operation.type,
    sourceLength: operation.sourceLength,
    nextLength: operation.nextLength,
    edits: operation.edits
  });
}

export function commitProvenancedMutation(
  store,
  mutationId,
  actualContentHash,
  options = {}
) {
  requireStore(store);
  const id = opaqueId(mutationId);
  const actual = opaqueId(actualContentHash);

  if (options.cancelled || options.success !== true) {
    return store.rollbackFileMutation(id);
  }

  const committedReference = options.committedReference == null
    ? undefined
    : opaqueId(options.committedReference);
  const result = store.commitFileMutation(id, actual, committedReference);
  if (result.status !== "mismatch") return result;

  // Preserve mismatch evidence while making the staged geometry non-reusable.
  return {
    ...result,
    rollback: store.rollbackFileMutation(id),
    reusable: false
  };
}

export function rollbackProvenancedMutation(store, mutationId) {
  requireStore(store);
  return store.rollbackFileMutation(opaqueId(mutationId));
}

/**
 * Reconcile observed hashes without guessing how a file changed. An existing
 * exact plan for the new content can be reused globally under the same policy.
 */
export function reconcileExternalFileChange(store, record) {
  requireStore(store);
  const oldContentHash = opaqueId(record.oldContentHash);
  const newContentHash = opaqueId(record.newContentHash);
  const policyFingerprint = record.policyFingerprint == null
    ? undefined
    : opaqueId(record.policyFingerprint);
  const planForNewHash = policyFingerprint
    ? store.getPrivacyPlan(newContentHash, policyFingerprint)
    : undefined;

  return {
    status: oldContentHash === newContentHash ? "unchanged" : "changed",
    oldContentHash,
    newContentHash,
    exactPlanReuse: Boolean(planForNewHash),
    globalPlanReuse: Boolean(planForNewHash),
    planForNewHash,
    previousPlan: policyFingerprint
      ? store.getPrivacyPlan(oldContentHash, policyFingerprint)
      : undefined
  };
}

/**
 * Propagate unaffected private spans through ordered, non-overlapping edits.
 * Intersected spans are invalidated. Known inserted references are registered
 * directly, while changed boundaries are returned as compact rescan ranges.
 */
export function propagatePrivacySpans(spans, edits, options = {}) {
  const sourceLength = requiredNonNegative(
    options.sourceLength,
    "sourceLength"
  );
  const overlap = optionalNonNegative(options.overlap ?? 64) ?? 64;
  const normalizedEdits = normalizeEdits(edits, sourceLength);
  const output = [];

  for (const span of normalizeSpans(spans, sourceLength)) {
    let shift = 0;
    let invalid = false;

    for (const edit of normalizedEdits) {
      // Half-open geometry: insertion at span.end leaves the span unchanged;
      // insertion at span.start shifts it; insertion inside invalidates it.
      if (span.end <= edit.start) break;
      if (
        span.start >= edit.end ||
        (edit.start === edit.end && span.start >= edit.end)
      ) {
        shift += edit.insertedLength - (edit.end - edit.start);
        continue;
      }
      invalid = true;
      break;
    }

    if (!invalid) {
      output.push({
        ...span,
        start: span.start + shift,
        end: span.end + shift
      });
    }
  }

  const rescans = [];
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

    rescans.push({
      start: nextStart - overlap,
      end: nextEnd + overlap
    });
    shift += edit.insertedLength - (edit.end - edit.start);
  }

  const nextLength = sourceLength + shift;
  return {
    spans: output.sort(compareSpans),
    rescanRanges: mergeRanges(rescans, nextLength),
    nextLength
  };
}

/**
 * Derive the reusable portion of a next privacy plan from a committed mutation.
 * Unknown rescan ranges must still be classified before the plan is complete.
 */
export function derivePrivacyPlanFromCommittedMutation(
  mutation,
  previousPlan,
  options = {}
) {
  if (!mutation || mutation.status !== "committed") {
    return { status: "unavailable", reason: "mutation_not_committed" };
  }
  if (
    mutation.operationType === "write_file" &&
    (!Number.isSafeInteger(mutation.sourceLength) ||
      !Number.isSafeInteger(mutation.nextLength))
  ) {
    return { status: "unavailable", reason: "full_write_lengths_unknown" };
  }

  const sourceLength = options.sourceLength ?? mutation.sourceLength;
  if (!Number.isSafeInteger(sourceLength)) {
    return { status: "unavailable", reason: "source_length_unknown" };
  }

  const result = propagatePrivacySpans(
    previousPlan?.spans || [],
    mutation.edits || [],
    { sourceLength, overlap: options.overlap }
  );

  return {
    status: "derived",
    contentHash: mutation.nextContentHash,
    policyFingerprint: previousPlan?.policyFingerprint,
    spans: result.spans,
    editPlan: result.spans.map(span => ({ ...span })),
    rescanRanges: result.rescanRanges,
    nextLength: result.nextLength
  };
}

function normalizeEdits(edits, sourceLength) {
  if (!Array.isArray(edits)) {
    throw new TypeError("mutation edits must be an array.");
  }

  let previousEnd = 0;
  return edits.map(edit => {
    const start = requiredNonNegative(edit?.start, "edit start");
    const end = requiredNonNegative(edit?.end, "edit end");
    if (
      end < start ||
      start < previousEnd ||
      (sourceLength != null && end > sourceLength)
    ) {
      throw new TypeError(
        "edits must be ordered, non-overlapping source ranges."
      );
    }
    previousEnd = end;

    const insertedLength = requiredNonNegative(
      edit.insertedLength ??
        edit.replacementLength ??
        textLength(edit.replacement ?? edit.newText),
      "insertedLength"
    );
    return {
      start,
      end,
      insertedLength,
      knownInsertions: normalizeInsertions(
        edit.knownInsertions || [],
        insertedLength
      )
    };
  });
}

function normalizeInsertions(values, insertedLength) {
  if (!Array.isArray(values)) {
    throw new TypeError("known insertions must be an array.");
  }

  let previousEnd = 0;
  return values.map(value => {
    const offset = requiredNonNegative(
      value?.offset ?? 0,
      "known insertion offset"
    );
    const length = requiredNonNegative(
      value?.length,
      "known insertion length"
    );
    if (offset < previousEnd || offset + length > insertedLength) {
      throw new TypeError(
        "known insertions must be ordered, non-overlapping, and within inserted text."
      );
    }
    previousEnd = offset + length;
    return {
      offset,
      length,
      classification: String(value.classification || "opaque_reference"),
      reference: opaqueId(value.reference)
    };
  });
}

function normalizeSpans(spans, sourceLength) {
  if (!Array.isArray(spans)) throw new TypeError("spans must be an array.");
  return spans.map(span => {
    const start = requiredNonNegative(span?.start, "span start");
    const end = requiredNonNegative(span?.end, "span end");
    if (end < start || end > sourceLength) {
      throw new TypeError("span must be within source length.");
    }
    return {
      start,
      end,
      classification: String(span.classification || "opaque_reference"),
      reference: opaqueId(span.reference)
    };
  });
}

function mergeRanges(ranges, max) {
  const sorted = ranges
    .map(range => ({
      start: Math.max(0, Math.min(max, range.start)),
      end: Math.max(0, Math.min(max, range.end))
    }))
    .filter(range => range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const output = [];
  for (const range of sorted) {
    const last = output.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      output.push(range);
    }
  }
  return output;
}

function compareSpans(left, right) {
  return left.start - right.start ||
    left.end - right.end ||
    left.reference.localeCompare(right.reference);
}

function resultingLength(sourceLength, edits) {
  return sourceLength + edits.reduce(
    (sum, edit) => sum + edit.insertedLength - (edit.end - edit.start),
    0
  );
}

function textLength(value) {
  return value == null ? 0 : String(value).length;
}

function fingerprint(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function opaqueId(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{6,}$/i.test(value)) {
    throw new TypeError(
      "mutation provenance requires opaque sha256 identifiers."
    );
  }
  return value;
}

function requiredNonNegative(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return normalized;
}

function optionalNonNegative(value) {
  return value == null
    ? undefined
    : requiredNonNegative(value, "value");
}

function requireStore(store) {
  if (!store || typeof store.stageFileMutation !== "function") {
    throw new TypeError("mutation provenance requires a ledger store.");
  }
}
