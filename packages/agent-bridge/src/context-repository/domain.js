import { createHash } from "node:crypto";
import { normalizeSessionMap } from "@privacy-ai/sdk";
import { collisionError } from "./errors.js";

export { normalizeSessionMap };

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verificationFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function emptyThread(sessionKey) {
  return { sessionKey, parentSessionKeys: [], sessionMap: {}, policyFingerprint: "", updatedAt: 0 };
}

export function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`PrivacyAI found malformed ${label} in its local context database.`);
  }
}

export const parseSessionMap = (value, label) => normalizeSessionMap(parseJson(value, label));
export const parseStringArray = (value, label) => normalizeStringArray(parseJson(value, label));

export function normalizeStringArray(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === "string" && item))] : [];
}

export function mergeThreadSessionMaps(current = {}, incoming = {}, base) {
  try {
    const normalizedCurrent = normalizeSessionMap(current);
    const normalizedIncoming = normalizeSessionMap(incoming);
    if (base === undefined) {
      const merged = { ...normalizedCurrent };
      for (const [placeholder, original] of Object.entries(normalizedIncoming)) {
        if (Object.hasOwn(merged, placeholder) && merged[placeholder] !== original) {
          throw new Error("placeholder collision");
        }
        merged[placeholder] = original;
      }
      return normalizeSessionMap(merged);
    }

    const normalizedBase = normalizeSessionMap(base);
    const merged = { ...normalizedCurrent };
    for (const [placeholder, original] of Object.entries(normalizedBase)) {
      if (Object.hasOwn(normalizedIncoming, placeholder)) {
        if (normalizedIncoming[placeholder] !== original) throw new Error("placeholder collision");
        continue;
      }
      if (!Object.hasOwn(merged, placeholder)) continue;
      if (merged[placeholder] !== original) throw new Error("placeholder collision");
      delete merged[placeholder];
    }
    for (const [placeholder, original] of Object.entries(normalizedIncoming)) {
      if (Object.hasOwn(normalizedBase, placeholder)) continue;
      if (Object.hasOwn(merged, placeholder) && merged[placeholder] !== original) {
        throw new Error("placeholder collision");
      }
      merged[placeholder] = original;
    }
    return normalizeSessionMap(merged);
  } catch {
    throw collisionError();
  }
}

export function requiredHash(value, name) {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty opaque hash.`);
  return value;
}

export function requiredOpaqueReference(value, name) {
  if (typeof value !== "string" || !/^sha(?:256|512):[^\s]{1,256}$/.test(value)) {
    throw new TypeError(`${name} must be an opaque hash reference.`);
  }
  return value;
}

export function optionalInteger(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("ledger numeric metadata must be a non-negative safe integer.");
  return number;
}

export const opaque = value => typeof value === "string" ? value : "";

export function positiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  return number;
}

export const compoundKey = (...parts) => parts.join("\0");
export const withoutLastUsed = ({ lastUsedAt: _lastUsedAt, ...value }) => value;

export function normalizeManifestEntries(value) {
  if (!Array.isArray(value)) throw new TypeError("manifest entries must be an array.");
  const entries = value.map(entry => ({
    pathHash: requiredHash(entry?.pathHash, "pathHash"),
    contentHash: requiredHash(entry?.contentHash, "contentHash"),
    gitBlobHash: entry?.gitBlobHash ? requiredHash(entry.gitBlobHash, "gitBlobHash") : null,
    mode: optionalInteger(entry?.mode)
  })).sort((left, right) => left.pathHash.localeCompare(right.pathHash));
  if (new Set(entries.map(entry => entry.pathHash)).size !== entries.length) {
    throw new TypeError("manifest entries must have unique path hashes.");
  }
  return entries;
}

function normalizeRanges(value, message, referenceName) {
  return (Array.isArray(value) ? value : []).map(item => {
    const start = optionalInteger(item?.start);
    const end = optionalInteger(item?.end);
    if (end < start || !item?.classification) throw new TypeError(message);
    return { start, end, classification: item.classification, reference: requiredOpaqueReference(item.reference, referenceName) };
  });
}

export function normalizePrivacySpans(value = []) {
  return normalizeRanges(value, "privacy spans require range and classification.", "span reference")
    .sort((left, right) => left.start - right.start || left.end - right.end || left.classification.localeCompare(right.classification));
}

export function normalizeEditPlan(value = []) {
  return normalizeRanges(value, "privacy edit plan requires valid ranges.", "edit reference")
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

export function normalizeFileMutation(record) {
  const operationType = String(record.operationType || "unknown");
  if (!["apply_patch", "replace_in_file", "write_file", "unknown"].includes(operationType)) {
    throw new TypeError("operationType must be a supported non-sensitive mutation type.");
  }
  const sourceLength = record.sourceLength == null ? null : optionalInteger(record.sourceLength);
  const nextLength = record.nextLength == null ? null : optionalInteger(record.nextLength);
  const edits = normalizeMutationEdits(record.edits || [], sourceLength);
  const geometry = edits.reduce((total, edit) => total + edit.insertedLength - (edit.end - edit.start), 0);
  if (sourceLength != null && nextLength != null && sourceLength + geometry !== nextLength) {
    throw new TypeError("mutation nextLength does not match edit geometry.");
  }
  return {
    mutationId: requiredHash(record.mutationId, "mutationId"),
    worktreeId: requiredHash(record.worktreeId, "worktreeId"),
    pathHash: requiredHash(record.pathHash, "pathHash"),
    expectedContentHash: requiredHash(record.expectedContentHash, "expectedContentHash"),
    nextContentHash: requiredHash(record.nextContentHash, "nextContentHash"),
    manifestHash: record.manifestHash ? requiredHash(record.manifestHash, "manifestHash") : null,
    opaqueReference: requiredOpaqueReference(record.opaqueReference, "opaqueReference"),
    operationType, sourceLength, nextLength, edits
  };
}

export function normalizeMutationEdits(edits, sourceLength) {
  if (!Array.isArray(edits)) throw new TypeError("mutation edits must be an array.");
  let previousEnd = 0;
  return edits.map(edit => {
    const start = optionalInteger(edit?.start);
    const end = optionalInteger(edit?.end);
    const insertedLength = optionalInteger(edit?.insertedLength);
    if (end < start || start < previousEnd || (sourceLength != null && end > sourceLength)) {
      throw new TypeError("mutation edits must be ordered, non-overlapping source ranges.");
    }
    previousEnd = end;
    let lastInsertionEnd = 0;
    const knownInsertions = (edit.knownInsertions || []).map(insertion => {
      const value = {
        offset: optionalInteger(insertion.offset),
        length: optionalInteger(insertion.length),
        classification: String(insertion.classification || "opaque_reference"),
        reference: requiredOpaqueReference(insertion.reference, "insertion reference")
      };
      if (value.offset < lastInsertionEnd || value.offset + value.length > insertedLength) {
        throw new TypeError("known insertions must be ordered, non-overlapping, and within inserted text.");
      }
      lastInsertionEnd = value.offset + value.length;
      return value;
    });
    return { start, end, insertedLength, knownInsertions };
  });
}

export function fileMutationRow(row, editRows = [], insertionRows = []) {
  const byEdit = new Map();
  for (const insertion of insertionRows) {
    if (!byEdit.has(insertion.edit_index)) byEdit.set(insertion.edit_index, []);
    byEdit.get(insertion.edit_index).push({
      offset: insertion.offset, length: insertion.length,
      classification: insertion.classification, reference: insertion.opaque_reference
    });
  }
  return {
    mutationId: row.mutation_id, worktreeId: row.worktree_id, pathHash: row.path_hash,
    expectedContentHash: row.expected_content_hash, nextContentHash: row.next_content_hash,
    manifestHash: row.manifest_hash, status: row.status, opaqueReference: row.opaque_reference,
    operationType: row.operation_type, sourceLength: row.source_length, nextLength: row.next_length,
    committedReference: row.committed_reference,
    edits: editRows.map(edit => ({
      start: edit.start_offset, end: edit.end_offset, insertedLength: edit.inserted_length,
      knownInsertions: byEdit.get(edit.edit_index) || []
    }))
  };
}

export const contentIdentityRow = row => ({ contentHash: row.content_hash, byteLength: row.byte_length, kind: row.kind });
export const fileMetadataRow = row => ({ worktreeId: row.worktree_id, pathHash: row.path_hash, contentHash: row.content_hash, byteLength: row.byte_length, mode: row.mode, metadataRef: row.metadata_ref });
export const manifestEntryRow = row => ({ pathHash: row.path_hash, contentHash: row.content_hash, gitBlobHash: row.git_blob_hash, mode: row.mode });
export const privacySpanRow = row => ({ start: row.start_offset, end: row.end_offset, classification: row.classification, reference: row.opaque_reference });
export const privacyEditRow = privacySpanRow;

export function sameMutation(row, value) {
  return row.worktree_id === value.worktreeId && row.path_hash === value.pathHash &&
    row.expected_content_hash === value.expectedContentHash && row.next_content_hash === value.nextContentHash &&
    row.manifest_hash === value.manifestHash && row.opaque_reference === value.opaqueReference &&
    row.operation_type === value.operationType && row.source_length === value.sourceLength && row.next_length === value.nextLength;
}

export function sameMutationMemory(row, value) {
  return row.worktreeId === value.worktreeId && row.pathHash === value.pathHash &&
    row.expectedContentHash === value.expectedContentHash && row.nextContentHash === value.nextContentHash &&
    row.manifestHash === value.manifestHash && row.opaqueReference === value.opaqueReference &&
    row.operationType === value.operationType && row.sourceLength === value.sourceLength &&
    row.nextLength === value.nextLength && stableJson(row.edits) === stableJson(value.edits);
}

export function sameMutationChildren(statements, value) {
  const row = { mutation_id: value.mutationId, worktree_id: value.worktreeId, path_hash: value.pathHash,
    expected_content_hash: value.expectedContentHash, next_content_hash: value.nextContentHash,
    manifest_hash: value.manifestHash, status: "pending", opaque_reference: value.opaqueReference,
    operation_type: value.operationType, source_length: value.sourceLength, next_length: value.nextLength };
  return stableJson(fileMutationRow(row, statements.getFileMutationEdits.all(value.mutationId), statements.getFileMutationInsertions.all(value.mutationId)).edits) === stableJson(value.edits);
}

export function mutationConflict(existing, attempted) {
  return {
    status: "conflict", reason: "mutation_geometry_or_hash_conflict",
    existing: typeof existing.mutation_id === "string" ? fileMutationRow(existing) : withoutLastUsed(existing),
    attemptedMutationId: attempted.mutationId
  };
}
