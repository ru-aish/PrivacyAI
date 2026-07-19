import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";

import { MemoryContextVerificationStore, openContextVerificationStore } from "../src/index.js";
import { createTestTempDir } from "./test-temp-dir.js";

const hash = value => `sha256:${value}`;
const childFixture = join(import.meta.dirname, "fixtures", "context-store-child.js");

async function opened(t, options = {}) {
  const root = await createTestTempDir("privacyai-a4-repository-");
  const path = join(root, "context.sqlite3");
  const store = await openContextVerificationStore({ verificationDbPath: path, ...options });
  t.after(() => store.close());
  return { root, path, store };
}

test("SQLite constructor creates private storage with WAL and FULL synchronous", async t => {
  const { root, path, store } = await opened(t);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(store.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.database.prepare("PRAGMA synchronous").get().synchronous, 2);
});

test("schema v3 has every table, legacy index, and critical CHECK constraint", async t => {
  const { store } = await opened(t);
  const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(tables, [
    "ledger_content_identities", "ledger_file_metadata", "ledger_file_mutation_edits",
    "ledger_file_mutation_insertions", "ledger_file_mutations", "ledger_file_versions",
    "ledger_git_blob_aliases", "ledger_manifest_entries", "ledger_manifests", "ledger_privacy_plan_edits",
    "ledger_privacy_plan_spans", "ledger_privacy_plans", "ledger_repositories", "ledger_worktrees",
    "privacyai_meta", "thread_items", "threads", "verified_items"
  ]);
  const indexes = store.database.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map(row => row.name);
  for (const name of ["threads_updated_idx", "verified_items_lru_idx", "thread_items_seen_idx", "ledger_worktrees_repo_path_idx", "ledger_privacy_plans_lookup_idx"]) assert.ok(indexes.includes(name));
  const sql = store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('ledger_file_mutations','ledger_file_mutation_edits','ledger_file_mutation_insertions')").all().map(row => row.sql).join(" ");
  assert.match(sql, /status IN \('pending', 'committed', 'rolled_back'\)/);
  assert.match(sql, /inserted_length >= 0/);
  assert.match(sql, /FOREIGN KEY\(mutation_id, edit_index\)/);
  assert.equal(store.database.prepare("SELECT value FROM privacyai_meta WHERE key='schema_version'").get().value, "3");
});

test("independent handles union thread state and collision rolls back all fields", async t => {
  const { path, store: left } = await opened(t);
  const right = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => right.close());
  left.saveThread("shared", { parentSessionKeys: ["parent-a"], sessionMap: { "[EMAIL_1]": "left@example.test" }, policyFingerprint: "left" });
  right.saveThread("shared", { parentSessionKeys: ["parent-a", "parent-b"], sessionMap: { "[PHONE_1]": "+1-555-0100" }, policyFingerprint: "right" });
  assert.deepEqual(right.loadThread("shared"), {
    sessionKey: "shared", parentSessionKeys: ["parent-a", "parent-b"],
    sessionMap: { "[EMAIL_1]": "left@example.test", "[PHONE_1]": "+1-555-0100" },
    policyFingerprint: "right", updatedAt: right.loadThread("shared").updatedAt
  });

  left.loadThread("shared");
  right.saveThread("shared", {
    sessionMap: {
      "[EMAIL_1]": "left@example.test",
      "[PHONE_1]": "+1-555-0100",
      "[ZIP_1]": "12345"
    }
  });
  left.saveThread("shared", {
    sessionMap: { "[PHONE_1]": "+1-555-0100" },
    policyFingerprint: "pruned"
  });
  const reconciled = right.loadThread("shared");
  assert.deepEqual(reconciled.sessionMap, {
    "[PHONE_1]": "+1-555-0100",
    "[ZIP_1]": "12345"
  });
  assert.equal(reconciled.policyFingerprint, "pruned");

  assert.throws(() => left.saveThread("shared", {
    parentSessionKeys: ["parent-c"],
    sessionMap: { "[PHONE_1]": "+1-555-9999", "[ZIP_1]": "12345" },
    policyFingerprint: "bad"
  }), error => error?.code === "PRIVACYAI_SESSION_MAP_COLLISION");
  const after = right.loadThread("shared");
  assert.deepEqual(after.parentSessionKeys, ["parent-a", "parent-b"]);
  assert.deepEqual(after.sessionMap, {
    "[PHONE_1]": "+1-555-0100",
    "[ZIP_1]": "12345"
  });
  assert.equal(after.policyFingerprint, "pruned");
});

test("child processes update the explicitly supplied database without lost mappings", async t => {
  const { path, store } = await opened(t);
  const env = { ...process.env, PRIVACYAI_CONTEXT_DB: join(await createTestTempDir("privacyai-a4-env-"), "wrong.sqlite3") };
  const jobs = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const child = import("node:child_process").then(({ spawn }) => spawn(process.execPath, [childFixture, path, "shared-child-thread", `[TOKEN_${index}]`, `original-${index}`], { env }));
    child.then(proc => { let output = ""; proc.stdout.on("data", chunk => { output += chunk; }); proc.once("error", reject); proc.once("close", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`child exited ${code}`))); });
  }));
  const results = await Promise.all(jobs);
  assert.deepEqual(results.map(result => result.path), [path, path, path, path]);
  const row = store.loadThread("shared-child-thread");
  for (let index = 0; index < 4; index += 1) {
    assert.equal(row.sessionMap[`[TOKEN_${index}]`], `original-${index}`);
  }
  assert.deepEqual(
    [...row.parentSessionKeys].sort(),
    Array.from({ length: 4 }, (_, index) => `parent:[TOKEN_${index}]`).sort()
  );
  assert.equal(env.PRIVACYAI_CONTEXT_DB === path, false);
});

test("expiry and pruning remove stale threads, verifications, and thread items", async t => {
  const { store } = await opened(t, { verificationMaxAgeMs: 10, maxThreads: 2, maxVerifiedItems: 2, maxThreadItems: 2 });
  for (let index = 0; index < 4; index += 1) {
    store.saveThread(`thread-${index}`, { sessionMap: {} });
    store.putVerification({ cacheKey: `cache-${index}`, contentHash: `content-${index}`, artifactType: "text", policyFingerprint: "p", sessionMapAdditions: {} });
    store.recordThreadItem({ sessionKey: `thread-${index}`, slotKey: "slot", cacheKey: `cache-${index}`, contentHash: `content-${index}`, artifactType: "text" });
  }
  store.prune();
  assert.ok(store.database.prepare("SELECT COUNT(*) count FROM threads").get().count <= 2);
  assert.ok(store.database.prepare("SELECT COUNT(*) count FROM verified_items").get().count <= 2);
  assert.ok(store.database.prepare("SELECT COUNT(*) count FROM thread_items").get().count <= 2);
  const old = await opened(t, { verificationMaxAgeMs: 1 });
  old.store.putVerification({ cacheKey: "old", contentHash: "old", artifactType: "text", policyFingerprint: "p", sessionMapAdditions: {} });
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.equal(old.store.getVerification("old", "p"), undefined);
});

test("SQLite close is idempotent and all representative public operations fail closed", async t => {
  const { store } = await opened(t);
  store.close(); store.close();
  const calls = [
    () => store.loadThread("x"), () => store.saveThread("x"), () => store.getVerification("x", "p"),
    () => store.putVerification({}), () => store.recordThreadItem({}), () => store.registerRepository({}),
    () => store.getRepository("x"), () => store.registerWorktree({}), () => store.getWorktree("x"),
    () => store.putContentIdentity({}), () => store.putGitBlobAlias({}), () => store.getContentIdentity("x"),
    () => store.findContentByGitBlob("x"), () => store.putFileMetadata({}), () => store.getFileMetadata("x", "y"),
    () => store.getFileVersion("x", "y", "z"), () => store.putManifest({}), () => store.getManifest("x"),
    () => store.putPrivacyPlan({}), () => store.getPrivacyPlan("x", "y"), () => store.stageFileMutation({}),
    () => store.getFileMutation("x"), () => store.commitFileMutation("x", hash("x")), () => store.rollbackFileMutation("x"),
    () => store.prune()
  ];
  for (const call of calls) assert.throws(call, error => error?.code === "PRIVACYAI_CONTEXT_DB_CLOSED");
});

test("memory fallback bounds every collection and preserves standalone ledger records", () => {
  const store = new MemoryContextVerificationStore({ maxThreads: 1, maxVerifiedItems: 1, maxThreadItems: 1, maxLedgerItems: 1 });
  store.saveThread("thread", { sessionMap: {} });
  store.putVerification({ cacheKey: "cache", contentHash: "content", artifactType: "text", policyFingerprint: "p", sessionMapAdditions: {} });
  store.recordThreadItem({ sessionKey: "thread", slotKey: "slot", cacheKey: "cache", contentHash: "content", artifactType: "text" });
  store.registerRepository({ repositoryId: hash("repo"), rootRef: hash("root") });
  store.registerWorktree({ worktreeId: hash("worktree"), repositoryId: hash("repo"), pathHash: hash("path"), metadataRef: hash("meta") });
  store.putContentIdentity({ contentHash: hash("content"), kind: "text" });
  store.putGitBlobAlias({ gitBlobHash: hash("blob"), contentHash: hash("content") });
  store.putFileMetadata({ worktreeId: hash("worktree"), pathHash: hash("path"), contentHash: hash("content"), metadataRef: hash("meta"), versionHash: hash("version"), versionRef: hash("version-ref") });
  store.putManifest({ worktreeId: hash("unmaterialized"), entries: [] });
  store.putPrivacyPlan({ contentHash: hash("unmaterialized"), policyFingerprint: hash("policy"), spans: [], editPlan: [] });
  store.stageFileMutation({ mutationId: hash("mutation"), worktreeId: hash("unmaterialized"), pathHash: hash("path"), expectedContentHash: hash("old"), nextContentHash: hash("new"), opaqueReference: hash("ref") });
  for (const name of ["threads", "threadBases", "verifications", "threadItems", "repositories", "worktrees", "contentIdentities", "gitBlobAliases", "fileMetadata", "fileVersions", "manifests", "privacyPlans", "fileMutations"]) assert.ok(store[name].size <= 1, name);
  store.close();
  for (const name of ["threads", "threadBases", "verifications", "threadItems", "repositories", "worktrees", "contentIdentities", "gitBlobAliases", "fileMetadata", "fileVersions", "manifests", "privacyPlans", "fileMutations"]) assert.equal(store[name].size, 0);
});

test("memory fallback preserves permissive parent handling while pruning unusable children", () => {
  const store = new MemoryContextVerificationStore();
  assert.doesNotThrow(() => store.registerWorktree({
    worktreeId: hash("orphan-worktree"),
    repositoryId: hash("missing-repository"),
    pathHash: hash("orphan-path"),
    metadataRef: hash("orphan-meta")
  }));
  assert.equal(store.getWorktree(hash("orphan-worktree")), undefined);

  assert.doesNotThrow(() => store.putContentIdentity({
    contentHash: hash("standalone-content"),
    kind: "text",
    gitBlobHash: hash("orphan-blob"),
    repositoryId: hash("missing-repository")
  }));
  assert.equal(store.getContentIdentity(hash("standalone-content")).kind, "text");
  assert.equal(store.findContentByGitBlob(hash("orphan-blob")), undefined);

  assert.doesNotThrow(() => store.putGitBlobAlias({
    gitBlobHash: hash("missing-content-blob"),
    contentHash: hash("missing-content")
  }));
  assert.equal(store.findContentByGitBlob(hash("missing-content-blob")), undefined);

  assert.doesNotThrow(() => store.putFileMetadata({
    worktreeId: hash("missing-worktree"),
    pathHash: hash("missing-path"),
    contentHash: hash("standalone-content"),
    metadataRef: hash("metadata"),
    versionHash: hash("version"),
    versionRef: hash("version-ref")
  }));
  assert.equal(store.getFileMetadata(hash("missing-worktree"), hash("missing-path")), undefined);
  assert.equal(store.getFileVersion(hash("missing-worktree"), hash("missing-path"), hash("version")), undefined);
  store.close();
});

test("malformed database rows and open failures do not expose private bytes or paths", async t => {
  const { root, path, store } = await opened(t);
  const secret = "PRIVATE-ROW-SECRET-DO-NOT-LOG";
  store.saveThread("corrupt-row", { sessionMap: {} });
  store.database.prepare("UPDATE threads SET session_map_json = ? WHERE session_key = ?")
    .run('{"secret": ' + secret + '}', "corrupt-row");
  assert.throws(() => store.loadThread("corrupt-row"), error => {
    const diagnostic = [error?.message, error?.stack, error?.cause?.message, error?.cause?.stack]
      .filter(Boolean).join("\n");
    return !diagnostic.includes(secret);
  });

  const privatePathFragment = "private-database-path-fragment";
  const directoryPath = join(root, privatePathFragment);
  await mkdir(directoryPath);
  await assert.rejects(openContextVerificationStore({ verificationDbPath: directoryPath }), error => {
    const diagnostic = [error?.message, error?.stack, error?.cause?.message, error?.cause?.stack]
      .filter(Boolean).join("\n");
    return error?.code === "PRIVACYAI_CONTEXT_DB_UNAVAILABLE" &&
      !diagnostic.includes(privatePathFragment) && !diagnostic.includes(path);
  });
});

test("corrupt, unsupported, and invalid-option opens fail closed without holding the file", async t => {
  const root = await createTestTempDir("privacyai-a4-open-failures-");
  const corrupt = join(root, "corrupt.sqlite3");
  await (await import("node:fs/promises")).writeFile(corrupt, "not sqlite", { mode: 0o600 });
  await assert.rejects(openContextVerificationStore({ verificationDbPath: corrupt }), error => error?.code === "PRIVACYAI_CONTEXT_DB_UNAVAILABLE");
  const db = new DatabaseSync(join(root, "unsupported.sqlite3"));
  db.exec("CREATE TABLE privacyai_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO privacyai_meta VALUES ('schema_version','999')"); db.close();
  await assert.rejects(openContextVerificationStore({ verificationDbPath: join(root, "unsupported.sqlite3") }), error => error?.code === "PRIVACYAI_CONTEXT_DB_SCHEMA_UNSUPPORTED");
  await assert.rejects(openContextVerificationStore({ verificationDbPath: join(root, "bad-option.sqlite3"), maxThreads: 0 }), error => error?.code === "PRIVACYAI_CONTEXT_DB_UNAVAILABLE");
  const reopened = await openContextVerificationStore({ verificationDbPath: join(root, "bad-option.sqlite3") });
  reopened.close();
  await chmod(join(root, "bad-option.sqlite3"), 0o600);
  const renamed = join(root, "bad-option-renamed.sqlite3");
  await (await import("node:fs/promises")).rename(join(root, "bad-option.sqlite3"), renamed);
  assert.equal((await stat(renamed)).mode & 0o777, 0o600);
});

test("transaction failures roll back parent and children and do not write the failure sentinel", async t => {
  const { path, store } = await opened(t);
  const sentinel = `failure-sentinel-${Date.now()}-${Math.random()}`;
  store.registerRepository({ repositoryId: hash("repo"), rootRef: hash("root") });
  store.registerWorktree({ worktreeId: hash("worktree"), repositoryId: hash("repo"), pathHash: hash("path"), metadataRef: hash("meta") });
  store.putContentIdentity({ contentHash: hash("content"), kind: "text" });
  const originalManifest = store.statements.putManifestEntry;
  store.statements.putManifestEntry = { run() { throw new Error(sentinel); } };
  assert.throws(
    () => store.putManifest({ manifestHash: hash("manifest"), worktreeId: hash("worktree"), entries: [{ pathHash: hash("manifest-path"), contentHash: hash("content") }] }),
    error => error?.code === "PRIVACYAI_CONTEXT_DB_WRITE_FAILED" &&
      !`${error.message}\n${error.stack}\n${error.cause || ""}`.includes(sentinel)
  );
  store.statements.putManifestEntry = originalManifest;
  assert.equal(store.database.prepare("SELECT COUNT(*) count FROM ledger_manifests WHERE manifest_hash=?").get(hash("manifest")).count, 0);

  const originalSpan = store.statements.putPrivacyPlanSpan;
  store.statements.putPrivacyPlanSpan = { run() { throw new Error(sentinel); } };
  assert.throws(() => store.putPrivacyPlan({ planHash: hash("plan"), contentHash: hash("content"), policyFingerprint: hash("policy"), spans: [{ start: 0, end: 1, classification: "token", reference: hash("span") }], editPlan: [] }), error => error?.code === "PRIVACYAI_CONTEXT_DB_WRITE_FAILED");
  store.statements.putPrivacyPlanSpan = originalSpan;
  assert.equal(store.database.prepare("SELECT COUNT(*) count FROM ledger_privacy_plans WHERE plan_hash=?").get(hash("plan")).count, 0);

  const originalEdit = store.statements.putFileMutationEdit;
  store.statements.putFileMutationEdit = { run() { throw new Error(sentinel); } };
  assert.throws(() => store.stageFileMutation({ mutationId: hash("mutation"), worktreeId: hash("worktree"), pathHash: hash("mutation-path"), expectedContentHash: hash("content"), nextContentHash: hash("next"), opaqueReference: hash("ref"), edits: [{ start: 0, end: 1, insertedLength: 1 }] }), error => error?.code === "PRIVACYAI_CONTEXT_DB_WRITE_FAILED");
  store.statements.putFileMutationEdit = originalEdit;
  assert.equal(store.database.prepare("SELECT COUNT(*) count FROM ledger_file_mutations WHERE mutation_id=?").get(hash("mutation")).count, 0);
  store.close();
  assert.equal((await readFile(path)).includes(sentinel), false);
  assert.equal((await readFile(`${path}-wal`).catch(() => Buffer.alloc(0))).includes(sentinel), false);
});
