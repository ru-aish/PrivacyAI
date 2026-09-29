import assert from "node:assert/strict";
import test from "node:test";

import { MemoryContextVerificationStore } from "../src/context-verification-store.js";
import { commitProvenancedMutation, derivePrivacyPlanFromCommittedMutation, normalizeFileMutationOperation, propagatePrivacySpans, reconcileExternalFileChange, stageProvenancedMutation } from "../src/mutation-provenance.js";

const id = value => `sha256:${value.charCodeAt(0).toString(16).padStart(64, "a")}`;
function ledger() {
  const value = new MemoryContextVerificationStore();
  value.registerRepository({ repositoryId: id("repo"), rootRef: id("root") });
  value.registerWorktree({ worktreeId: id("worktree"), repositoryId: id("repo"), pathHash: id("worktree-path"), metadataRef: id("meta") });
  return value;
}

test("provenance stages, commits only matching successful hashes, and rolls back failures", () => {
  const value = ledger();
  const record = { mutationId: id("mutation"), worktreeId: id("worktree"), pathHash: id("path"), expectedContentHash: id("old"), nextContentHash: id("new"), operation: { type: "replace_in_file", edits: [{ start: 2, end: 4, replacementLength: 3 }] } };
  assert.equal(stageProvenancedMutation(value, record).status, "pending");
  const mismatch = commitProvenancedMutation(value, record.mutationId, id("wrong"), { success: true });
  assert.equal(mismatch.status, "mismatch"); assert.equal(mismatch.rollback.status, "rolled_back"); assert.equal(mismatch.reusable, false);
  stageProvenancedMutation(value, record);
  assert.equal(commitProvenancedMutation(value, record.mutationId, id("new"), { success: true }).status, "committed");
  assert.equal(commitProvenancedMutation(value, record.mutationId, id("new"), { success: true }).status, "committed");
});

test("operation normalization and span propagation retain only proven unaffected references", () => {
  assert.equal(normalizeFileMutationOperation({ type: "write_file", byteLength: 8 }).editCount, 0);
  assert.equal(normalizeFileMutationOperation({ type: "apply_patch", edits: [{ start: 0, end: 1, replacement: "xx" }] }).edits[0].insertedLength, 2);
  const result = propagatePrivacySpans(
    [{ start: 0, end: 2, classification: "token", reference: id("left") }, { start: 4, end: 6, classification: "token", reference: id("cut") }, { start: 8, end: 10, classification: "token", reference: id("right") }],
    [{ start: 3, end: 7, insertedLength: 2, knownInsertions: [{ offset: 0, length: 2, classification: "placeholder", reference: id("insert") }] }],
    { sourceLength: 12, overlap: 3 }
  );
  assert.deepEqual(result.spans.map(span => [span.start, span.end, span.reference]), [[0, 2, id("left")], [3, 5, id("insert")], [6, 8, id("right")]]);
  assert.deepEqual(result.rescanRanges, [{ start: 0, end: 8 }]);
  assert.throws(() => propagatePrivacySpans([], [{ start: 2, end: 4, insertedLength: 1 }, { start: 3, end: 5, insertedLength: 1 }], { sourceLength: 8 }), /non-overlapping/);
  assert.throws(() => propagatePrivacySpans([], [{ start: 0, end: 0, insertedLength: 4, knownInsertions: [{ offset: 2, length: 2, reference: id("a") }, { offset: 1, length: 1, reference: id("b") }] }], { sourceLength: 0 }), /known insertions/);
});

test("normalizes full writes, preserves boundary spans, and derives compact plans", () => {
  const full = normalizeFileMutationOperation({ type: "write_file", sourceLength: 8, nextLength: 3 });
  assert.deepEqual(full.edits.map(edit => [edit.start, edit.end, edit.insertedLength]), [[0, 8, 3]]);
  assert.equal(normalizeFileMutationOperation({ type: "write_file" }).fullWrite, true);
  const boundary = propagatePrivacySpans([{ start: 2, end: 4, reference: id("span") }], [{ start: 2, end: 2, insertedLength: 1 }], { sourceLength: 6 });
  assert.deepEqual(boundary.spans.map(span => [span.start, span.end]), [[3, 5]]);
  const derived = derivePrivacyPlanFromCommittedMutation({ status: "committed", operationType: "write_file", sourceLength: 6, nextLength: 2, nextContentHash: id("new"), edits: [{ start: 0, end: 6, insertedLength: 2, knownInsertions: [{ offset: 0, length: 2, classification: "token", reference: id("newspan") }] }] }, { policyFingerprint: id("policy"), spans: [{ start: 1, end: 2, reference: id("oldspan") }] });
  assert.equal(derived.status, "derived"); assert.deepEqual(derived.spans.map(span => span.reference), [id("newspan")]);
});

test("reconciliation accepts observed hashes without inferring writes or retaining plaintext", () => {
  const value = ledger();
  const changed = reconcileExternalFileChange(value, { oldContentHash: id("old"), newContentHash: id("new") });
  assert.equal(changed.status, "changed");
  assert.throws(() => normalizeFileMutationOperation({ type: "shell_command" }), /operation type/);
  value.putPrivacyPlan({ contentHash: id("new"), policyFingerprint: id("policy"), spans: [], editPlan: [] });
  assert.equal(reconcileExternalFileChange(value, { oldContentHash: id("old"), newContentHash: id("new"), policyFingerprint: id("policy") }).exactPlanReuse, true);
});
