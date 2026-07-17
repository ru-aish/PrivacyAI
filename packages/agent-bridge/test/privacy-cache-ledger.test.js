import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryContextVerificationStore, openContextVerificationStore } from "../src/context-verification-store.js";
import { stageProvenancedMutation } from "../src/mutation-provenance.js";

const id = value => `sha256:${value}`;

async function store(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "privacyai-ledger-"));
  const value = await openContextVerificationStore({ verificationDbPath: join(root, "ledger.sqlite3"), ...options });
  t.after(() => value.close());
  return value;
}

function seed(store) {
  store.registerRepository({ repositoryId: id("repo"), rootRef: id("root") });
  store.registerWorktree({ worktreeId: id("worktree"), repositoryId: id("repo"), pathHash: id("worktree-path"), metadataRef: id("worktree-meta") });
  store.putContentIdentity({ contentHash: id("content"), byteLength: 42, kind: "text", gitBlobHash: id("blob"), repositoryId: id("repo") });
}

test("migrates a v1 context database and retains existing records", async t => {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { t.skip("node:sqlite unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "privacyai-ledger-migration-"));
  const path = join(root, "ledger.sqlite3");
  const db = new sqlite.DatabaseSync(path);
  db.exec("CREATE TABLE privacyai_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE threads (session_key TEXT PRIMARY KEY,parent_keys_json TEXT NOT NULL,session_map_json TEXT NOT NULL,policy_fingerprint TEXT NOT NULL,updated_at INTEGER NOT NULL); INSERT INTO privacyai_meta VALUES ('schema_version','1'); INSERT INTO threads VALUES ('old','[]','{}','policy',1)");
  db.close();
  const value = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => value.close());
  assert.equal(value.loadThread("old").policyFingerprint, "policy");
  value.registerRepository({ repositoryId: id("repo"), rootRef: id("root") });
});

test("migrates v2 mutations to v3 child geometry tables", async t => {
  let sqlite; try { sqlite = await import("node:sqlite"); } catch { t.skip("node:sqlite unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "privacyai-ledger-v2-migration-")); const path = join(root, "ledger.sqlite3");
  const db = new sqlite.DatabaseSync(path);
  db.exec("CREATE TABLE privacyai_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO privacyai_meta VALUES ('schema_version','2'); CREATE TABLE ledger_file_mutations (mutation_id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL,path_hash TEXT NOT NULL,expected_content_hash TEXT NOT NULL,next_content_hash TEXT NOT NULL,manifest_hash TEXT,status TEXT NOT NULL,opaque_reference TEXT NOT NULL,committed_reference TEXT,created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL);"); db.close();
  const value = await openContextVerificationStore({ verificationDbPath: path }); t.after(() => value.close());
  assert.deepEqual(value.database.prepare("PRAGMA table_info(ledger_file_mutations)").all().map(column => column.name).filter(name => ["operation_type", "source_length", "next_length"].includes(name)), ["operation_type", "source_length", "next_length"]);
  assert.equal(value.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_file_mutation_edits'").get().name, "ledger_file_mutation_edits");
});

test("stores normalized metadata and reuses content through a git blob across worktrees", async t => {
  const value = await store(t); seed(value);
  value.registerWorktree({ worktreeId: id("worktree-2"), repositoryId: id("repo"), pathHash: id("worktree-path-2"), metadataRef: id("worktree-meta-2") });
  value.putFileMetadata({ worktreeId: id("worktree"), pathHash: id("path"), contentHash: id("content"), byteLength: 42, mode: 33188, metadataRef: id("meta"), versionHash: id("version"), gitBlobHash: id("blob"), versionRef: id("version-ref") });
  assert.deepEqual(value.getContentIdentity(id("content")), { contentHash: id("content"), byteLength: 42, kind: "text" });
  assert.equal(value.findContentByGitBlob(id("blob")).contentHash, id("content"));
  assert.equal(value.getFileMetadata(id("worktree"), id("path")).metadataRef, id("meta"));
  assert.equal(value.getFileVersion(id("worktree"), id("path"), id("version")).gitBlobHash, id("blob"));
});

test("manifests, privacy plans, and mutation state transitions are deterministic", async t => {
  const value = await store(t); seed(value);
  const manifest = value.putManifest({ worktreeId: id("worktree"), metadataRef: id("manifest-meta"), entries: [{ pathHash: id("b"), contentHash: id("content"), mode: 33188 }, { pathHash: id("a"), contentHash: id("content"), gitBlobHash: id("blob"), mode: 33188 }] });
  assert.deepEqual(value.getManifest(manifest.manifestHash).entries.map(entry => entry.pathHash), [id("a"), id("b")]);
  value.putPrivacyPlan({ contentHash: id("content"), policyFingerprint: id("policy"), spans: [{ start: 3, end: 9, classification: "email", reference: id("span") }], editPlan: [{ start: 3, end: 9, classification: "email", reference: id("edit") }] });
  assert.equal(value.getPrivacyPlan(id("content"), id("policy")).spans[0].classification, "email");
  value.stageFileMutation({ mutationId: id("mutation"), worktreeId: id("worktree"), pathHash: id("path"), expectedContentHash: id("content"), nextContentHash: id("next"), manifestHash: manifest.manifestHash, opaqueReference: id("pending") });
  assert.equal(value.commitFileMutation(id("mutation"), id("wrong")).status, "mismatch");
  assert.equal(value.commitFileMutation(id("mutation"), id("next"), id("committed")).status, "committed");
  value.stageFileMutation({ mutationId: id("rollback"), worktreeId: id("worktree"), pathHash: id("path"), expectedContentHash: id("content"), nextContentHash: id("next"), opaqueReference: id("pending") });
  assert.equal(value.rollbackFileMutation(id("rollback")).status, "rolled_back");
});

test("mutation geometry is relational, transactional, conflict-safe, and cascades", async t => {
  const value = await store(t, { maxLedgerItems: 1 }); seed(value);
  const record = { mutationId: id("geometry"), worktreeId: id("worktree"), pathHash: id("path"), expectedContentHash: id("content"), nextContentHash: id("next"), opaqueReference: id("operation"), operationType: "apply_patch", sourceLength: 10, nextLength: 12, edits: [{ start: 1, end: 3, insertedLength: 4, knownInsertions: [{ offset: 1, length: 2, classification: "token", reference: id("insertion") }] }] };
  assert.deepEqual(value.stageFileMutation(record).edits, [{ start: 1, end: 3, insertedLength: 4, knownInsertions: [{ offset: 1, length: 2, classification: "token", reference: id("insertion") }] }]);
  assert.equal(value.stageFileMutation(record).status, "pending");
  assert.equal(value.stageFileMutation({ ...record, nextContentHash: id("different") }).status, "conflict");
  assert.equal(value.rollbackFileMutation(record.mutationId).status, "rolled_back");
  assert.equal(value.stageFileMutation({ ...record, nextContentHash: id("restaged") }).nextContentHash, id("restaged"));
  assert.equal(value.commitFileMutation(record.mutationId, id("restaged")).status, "committed");
  assert.equal(value.commitFileMutation(record.mutationId, id("restaged")).status, "committed");
  assert.equal(value.stageFileMutation(record).status, "conflict");
  value.registerRepository({ repositoryId: id("repo-2"), rootRef: id("root-2") }); value.prune();
  assert.equal(value.database.prepare("SELECT COUNT(*) AS count FROM ledger_file_mutation_edits").get().count, 0);
});

test("concurrent SQLite handles deterministically stage one mutation", async t => {
  const value = await store(t); seed(value);
  const second = await openContextVerificationStore({ verificationDbPath: value.path }); t.after(() => second.close());
  const record = { mutationId: id("concurrent"), worktreeId: id("worktree"), pathHash: id("path"), expectedContentHash: id("content"), nextContentHash: id("next"), opaqueReference: id("operation"), operationType: "replace_in_file", edits: [{ start: 0, end: 0, insertedLength: 1 }] };
  assert.equal(value.stageFileMutation(record).status, "pending");
  assert.equal(second.stageFileMutation(record).status, "pending");
  assert.equal(second.stageFileMutation({ ...record, nextContentHash: id("other") }).status, "conflict");
});

test("privacy ranges are relational and accept opaque references only", async t => {
  const value = await store(t); seed(value);
  assert.throws(() => value.putPrivacyPlan({
    contentHash: id("content"), policyFingerprint: id("policy"),
    spans: [{ start: 0, end: 1, classification: "token", reference: "raw-private-value" }], editPlan: []
  }), /opaque hash/);
  value.putPrivacyPlan({
    contentHash: id("content"), policyFingerprint: id("policy"),
    spans: [{ start: 0, end: 1, classification: "token", reference: id("span-ref") }],
    editPlan: [{ start: 0, end: 1, classification: "replace", reference: id("edit-ref") }]
  });
  const columns = value.database.prepare("PRAGMA table_info(ledger_privacy_plans)").all().map(column => column.name);
  assert.equal(columns.includes("spans_json") || columns.includes("edit_plan_json"), false);
  assert.deepEqual(value.getPrivacyPlan(id("content"), id("policy")).spans, [{ start: 0, end: 1, classification: "token", reference: id("span-ref") }]);
});

test("ledger pruning, failures, WAL opens, and memory fallback are bounded", async t => {
  const value = await store(t, { maxLedgerItems: 1, verificationMaxAgeMs: 5 }); seed(value);
  value.putContentIdentity({ contentHash: id("content-2"), kind: "text" });
  value.prune();
  assert.equal(value.getContentIdentity(id("content")) === undefined || value.getContentIdentity(id("content-2")) !== undefined, true);
  assert.throws(() => value.putManifest({ worktreeId: id("worktree"), entries: [{ pathHash: id("x"), contentHash: id("content-2") }, { pathHash: id("x"), contentHash: id("content-2") }] }), /unique path hashes/);
  const memory = new MemoryContextVerificationStore({ maxLedgerItems: 1 }); seed(memory); memory.putContentIdentity({ contentHash: id("memory-2"), kind: "text" }); assert.equal(memory.contentIdentities.size, 1);
  const second = await openContextVerificationStore({ verificationDbPath: value.path }); t.after(() => second.close());
  second.registerRepository({ repositoryId: id("repo-2"), rootRef: id("root-2") });
  assert.equal(second.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
});

test("pruning ownership roots cascades worktree children without incomplete manifests", async t => {
  const value = await store(t, { maxLedgerItems: 1 });
  seed(value);
  value.putManifest({ worktreeId: id("worktree"), metadataRef: id("manifest"), entries: [{ pathHash: id("path"), contentHash: id("content") }] });
  value.registerRepository({ repositoryId: id("repo-2"), rootRef: id("root-2") });
  value.prune();
  assert.equal(value.getWorktree(id("worktree")), undefined);
  const manifests = value.database.prepare("SELECT COUNT(*) AS count FROM ledger_manifest_entries WHERE manifest_hash NOT IN (SELECT manifest_hash FROM ledger_manifests)").get();
  assert.equal(manifests.count, 0);
});

test("SQLite thread pruning applies both LRU bounds and age", async t => {
  const value = await store(t, { maxThreads: 1, verificationMaxAgeMs: 5 });
  value.saveThread("old", { sessionMap: {} });
  await new Promise(resolve => setTimeout(resolve, 8));
  value.saveThread("new", { sessionMap: {} });
  value.prune();
  assert.equal(value.loadThread("old").updatedAt, 0);
  await new Promise(resolve => setTimeout(resolve, 8));
  value.prune();
  assert.equal(value.loadThread("new").updatedAt, 0);
});

test("new ledger rows and database bytes never contain plaintext fixture secrets", async t => {
  const value = await store(t); seed(value);
  const secret = "ledger-secret-fixture-DO-NOT-PERSIST";
  const opaque = character => `sha256:${character.repeat(64)}`;
  value.registerRepository({ repositoryId: opaque("f"), rootRef: opaque("f") });
  value.registerWorktree({ worktreeId: opaque("b"), repositoryId: opaque("f"), pathHash: opaque("c"), metadataRef: opaque("f") });
  value.putPrivacyPlan({ contentHash: id("content"), policyFingerprint: id("policy"), spans: [{ start: 0, end: 1, classification: "token", reference: id("span-ref") }], editPlan: [{ start: 0, end: 1, classification: "replace", reference: id("edit-ref") }] });
  assert.throws(() => value.stageFileMutation({ mutationId: id("rejected-secret"), worktreeId: id("worktree"), pathHash: id("path"), expectedContentHash: id("content"), nextContentHash: id("next"), opaqueReference: secret }), /opaque hash reference/);
  value.stageFileMutation({ mutationId: id("secret-mutation"), worktreeId: id("worktree"), pathHash: id("path"), expectedContentHash: id("content"), nextContentHash: id("next"), opaqueReference: id("pending-ref") });
  stageProvenancedMutation(value, { mutationId: opaque("a"), worktreeId: opaque("b"), pathHash: opaque("c"), expectedContentHash: opaque("d"), nextContentHash: opaque("e"), operation: { type: "replace_in_file", edits: [{ start: 0, end: 0, replacement: secret }] } });
  value.close();
  assert.equal((await readFile(value.path)).includes(Buffer.from(secret)), false);
});
