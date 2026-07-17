import assert from "node:assert/strict";
import test from "node:test";

import { MemoryContextVerificationStore } from "../src/context-verification-store.js";
import { commitProvenancedMutation, normalizeFileMutationOperation, propagatePrivacySpans, reconcileExternalFileChange, stageProvenancedMutation } from "../src/mutation-provenance.js";

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
  assert.equal(commitProvenancedMutation(value, record.mutationId, id("wrong"), { success: true }).status, "rolled_back");
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
});

test("reconciliation accepts observed hashes without inferring writes or retaining plaintext", () => {
  const value = ledger();
  const changed = reconcileExternalFileChange(value, { oldContentHash: id("old"), newContentHash: id("new") });
  assert.equal(changed.status, "changed");
  assert.throws(() => normalizeFileMutationOperation({ type: "shell_command" }), /operation type/);
});
