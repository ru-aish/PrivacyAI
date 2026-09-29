import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MemoryContextVerificationStore,
  openContextVerificationStore,
  updateRepositoryThread
} from "../src/index.js";
import { stableJson } from "../src/context-repository/domain.js";
import { initializeSchema } from "../src/context-repository/schema.js";
import { createTestTempDir } from "./test-temp-dir.js";

const hash = value => `sha256:${value}`;
const childFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "context-store-child.js");

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

test("explicit database paths preserve caller-owned parent permissions", async t => {
  const root = await createTestTempDir("privacyai-explicit-db-parent-");
  const parent = join(root, "shared-parent");
  await mkdir(parent, { mode: 0o755 });
  await chmod(parent, 0o755);
  const path = join(parent, "context.sqlite3");
  const store = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => store.close());
  assert.equal((await stat(parent)).mode & 0o777, 0o755);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("stable JSON matches JSON.stringify undefined handling", () => {
  assert.equal(stableJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(stableJson([1, undefined]), '[1,null]');
});

test("legacy repository updates serialize by session across store wrappers", async () => {
  const threads = new Map([["shared", {
    sessionKey: "shared",
    parentSessionKeys: [],
    sessionMap: {},
    policyFingerprint: "",
    updatedAt: 0
  }]]);
  const savedRecords = [];
  const createStore = () => ({
    async loadThread(sessionKey) {
      await new Promise(resolve => setTimeout(resolve, 5));
      return structuredClone(threads.get(sessionKey));
    },
    async saveThread(sessionKey, record) {
      await new Promise(resolve => setTimeout(resolve, 5));
      savedRecords.push(structuredClone(record));
      threads.set(sessionKey, { ...structuredClone(record), sessionKey });
      return threads.get(sessionKey);
    }
  });
  const left = createStore();
  const right = createStore();

  await Promise.all([
    updateRepositoryThread(left, "shared", current => ({
      ...current,
      baseSessionMap: current.sessionMap,
      sessionMap: { ...current.sessionMap, "[EMAIL_1]": "alice@example.test" }
    })),
    updateRepositoryThread(right, "shared", current => ({
      ...current,
      baseSessionMap: current.sessionMap,
      sessionMap: { ...current.sessionMap, "[PHONE_1]": "+1-555-0100" }
    }))
  ]);

  assert.deepEqual(threads.get("shared").sessionMap, {
    "[EMAIL_1]": "alice@example.test",
    "[PHONE_1]": "+1-555-0100"
  });
  assert.equal(savedRecords.some(record => Object.hasOwn(record, "baseSessionMap")), false);
});

test("same SQLite handle preserves independently derived concurrent additions", async t => {
  const { store } = await opened(t);
  store.saveThread("same-handle", { sessionMap: { "[BASE_1]": "base" } });
  const callerA = store.loadThread("same-handle");
  const callerB = store.loadThread("same-handle");

  store.saveThread("same-handle", {
    sessionMap: { ...callerA.sessionMap, "[EMAIL_1]": "alice@example.test" }
  });
  store.saveThread("same-handle", {
    sessionMap: { ...callerB.sessionMap, "[PHONE_1]": "+1-555-0100" }
  });

  assert.deepEqual(store.loadThread("same-handle").sessionMap, {
    "[BASE_1]": "base",
    "[EMAIL_1]": "alice@example.test",
    "[PHONE_1]": "+1-555-0100"
  });
});

test("same memory handle preserves independently derived concurrent additions", () => {
  const store = new MemoryContextVerificationStore();
  store.saveThread("same-handle", { sessionMap: { "[BASE_1]": "base" } });
  const callerA = store.loadThread("same-handle");
  const callerB = store.loadThread("same-handle");

  store.saveThread("same-handle", {
    sessionMap: { ...callerA.sessionMap, "[EMAIL_1]": "alice@example.test" }
  });
  store.saveThread("same-handle", {
    sessionMap: { ...callerB.sessionMap, "[PHONE_1]": "+1-555-0100" }
  });

  assert.deepEqual(store.loadThread("same-handle").sessionMap, {
    "[BASE_1]": "base",
    "[EMAIL_1]": "alice@example.test",
    "[PHONE_1]": "+1-555-0100"
  });
  store.close();
});

test("memory and SQLite retain the latest thread when the clock does not advance", async t => {
  const { store: sqlite } = await opened(t, { maxThreads: 1 });
  const memory = new MemoryContextVerificationStore({ maxThreads: 1 });
  t.after(() => memory.close());
  t.mock.method(Date, "now", () => 1_000);

  for (const store of [sqlite, memory]) {
    store.saveThread("old", { sessionMap: { "[OLD_1]": "old" } });
    store.saveThread("new", { sessionMap: { "[NEW_1]": "new" } });
    store.prune();
    assert.deepEqual(store.loadThread("old").sessionMap, {});
    assert.deepEqual(store.loadThread("new").sessionMap, { "[NEW_1]": "new" });
  }
});

test("atomic thread updates express deletion explicitly with memory and SQLite parity", async t => {
  const { path, store: sqlite } = await opened(t);
  const memory = new MemoryContextVerificationStore();
  t.after(() => memory.close());
  const results = [];
  const rejectedOriginal = "REJECTED-ORIGINAL-SENTINEL";

  for (const store of [sqlite, memory]) {
    store.saveThread("atomic-parity", {
      parentSessionKeys: ["parent-a"],
      sessionMap: {
        "[BASE_1]": "base",
        "[EMAIL_1]": "alice@example.test"
      },
      policyFingerprint: "initial"
    });
    const updated = store.updateThread("atomic-parity", current => {
      const sessionMap = { ...current.sessionMap, "[PHONE_1]": "+1-555-0100" };
      delete sessionMap["[EMAIL_1]"];
      return {
        parentSessionKeys: ["parent-b"],
        sessionMap,
        policyFingerprint: "updated"
      };
    });
    results.push({
      parentSessionKeys: updated.parentSessionKeys,
      sessionMap: updated.sessionMap,
      policyFingerprint: updated.policyFingerprint
    });
    const beforeCollision = store.loadThread("atomic-parity");
    assert.throws(() => store.updateThread("atomic-parity", current => ({
      ...current,
      parentSessionKeys: ["parent-c"],
      sessionMap: { ...current.sessionMap, "[PHONE_1]": rejectedOriginal },
      policyFingerprint: "rejected"
    })), error => {
      const diagnostic = [error?.message, error?.stack, error?.cause?.message, error?.cause?.stack]
        .filter(Boolean).join("\n");
      return error?.code === "PRIVACYAI_SESSION_MAP_COLLISION" &&
        !diagnostic.includes(rejectedOriginal);
    });
    assert.deepEqual(store.loadThread("atomic-parity"), beforeCollision);
    assert.throws(
      () => store.updateThread("atomic-parity", async current => current),
      /must return a thread record synchronously/
    );
  }

  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], {
    parentSessionKeys: ["parent-a", "parent-b"],
    sessionMap: {
      "[BASE_1]": "base",
      "[PHONE_1]": "+1-555-0100"
    },
    policyFingerprint: "updated"
  });
  assert.equal((await readFile(path)).includes(rejectedOriginal), false);
  assert.equal((await readFile(`${path}-wal`).catch(() => Buffer.alloc(0))).includes(rejectedOriginal), false);
});

test("atomic updates remain correct after thread pruning", async t => {
  const { store: sqlite } = await opened(t, { maxThreads: 1 });
  const memory = new MemoryContextVerificationStore({ maxThreads: 1 });
  t.after(() => memory.close());

  for (const store of [sqlite, memory]) {
    store.saveThread("evicted", { sessionMap: { "[OLD_1]": "old" } });
    if (store.persistent) {
      store.database.prepare("UPDATE threads SET updated_at = 1 WHERE session_key = ?").run("evicted");
    } else {
      store.threads.get("evicted").updatedAt = 1;
    }
    store.saveThread("keeper", { sessionMap: { "[KEEP_1]": "keep" } });
    store.prune();
    assert.deepEqual(store.loadThread("evicted").sessionMap, {});

    store.updateThread("evicted", current => ({
      ...current,
      sessionMap: { ...current.sessionMap, "[ONE_1]": "one" }
    }));
    store.updateThread("evicted", current => ({
      ...current,
      sessionMap: { ...current.sessionMap, "[TWO_1]": "two" }
    }));
    assert.deepEqual(store.loadThread("evicted").sessionMap, {
      "[ONE_1]": "one",
      "[TWO_1]": "two"
    });
  }
});

test("schema v4 has identity columns, every table, legacy index, and critical CHECK constraint", async t => {
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
  assert.equal(store.database.prepare("SELECT value FROM privacyai_meta WHERE key='schema_version'").get().value, "4");
});

test("schema v3 upgrades identity columns without losing existing maps", async t => {
  const root = await createTestTempDir("privacyai-context-v3-upgrade-");
  const path = join(root, "context.sqlite3");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE privacyai_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE threads (
      session_key TEXT PRIMARY KEY,
      parent_keys_json TEXT NOT NULL,
      session_map_json TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE verified_items (
      cache_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      additions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  database.prepare("INSERT INTO privacyai_meta(key,value) VALUES (?, ?)").run("schema_version", "3");
  database.prepare(`
    INSERT INTO threads(session_key,parent_keys_json,session_map_json,policy_fingerprint,updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "legacy-thread",
    JSON.stringify(["legacy-parent"]),
    JSON.stringify({ "[EMAIL_1]": "legacy@example.test" }),
    "legacy-policy",
    123
  );
  const now = Date.now();
  database.prepare(`
    INSERT INTO verified_items(
      cache_key,content_hash,artifact_type,policy_fingerprint,
      additions_json,created_at,last_used_at,hit_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-cache",
    "legacy-content",
    "instructions",
    "legacy-policy",
    JSON.stringify({ "[EMAIL_1]": "legacy@example.test" }),
    now,
    now,
    0
  );
  database.close();

  await assert.rejects(
    openContextVerificationStore({ verificationDbPath: path }),
    error => error?.code === "PRIVACYAI_CONTEXT_DB_SCHEMA_MIGRATION_REQUIRED"
  );
  const beforeMigration = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    beforeMigration.prepare("SELECT value FROM privacyai_meta WHERE key='schema_version'").get().value,
    "3"
  );
  beforeMigration.close();
  const migration = new DatabaseSync(path);
  initializeSchema(migration, { allowMigration: true });
  migration.close();

  const store = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => store.close());
  assert.deepEqual(store.loadThread("legacy-thread"), {
    sessionKey: "legacy-thread",
    parentSessionKeys: ["legacy-parent"],
    sessionMap: { "[EMAIL_1]": "legacy@example.test" },
    policyFingerprint: "legacy-policy",
    updatedAt: 123
  });
  assert.deepEqual(
    store.getVerification("legacy-cache", "legacy-policy").sessionMapAdditions,
    { "[EMAIL_1]": "legacy@example.test" }
  );
  assert.equal(
    store.database.prepare("SELECT value FROM privacyai_meta WHERE key='schema_version'").get().value,
    "4"
  );
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

  const callerBase = left.loadThread("shared");
  right.saveThread("shared", {
    sessionMap: {
      "[EMAIL_1]": "left@example.test",
      "[PHONE_1]": "+1-555-0100",
      "[ZIP_1]": "12345"
    }
  });
  left.updateThread("shared", () => ({
    baseSessionMap: callerBase.sessionMap,
    sessionMap: { "[PHONE_1]": "+1-555-0100" },
    policyFingerprint: "pruned"
  }));
  const reconciled = right.loadThread("shared");
  assert.deepEqual(reconciled.sessionMap, {
    "[PHONE_1]": "+1-555-0100",
    "[ZIP_1]": "12345"
  });
  assert.equal(reconciled.policyFingerprint, "pruned");

  const beforeCollision = right.loadThread("shared");
  assert.throws(() => left.updateThread("shared", current => ({
    ...current,
    parentSessionKeys: ["parent-c"],
    sessionMap: { ...current.sessionMap, "[PHONE_1]": "+1-555-9999" },
    policyFingerprint: "bad"
  })), error => error?.code === "PRIVACYAI_SESSION_MAP_COLLISION");
  assert.deepEqual(right.loadThread("shared"), beforeCollision);
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
    () => store.loadThread("x"), () => store.saveThread("x"), () => store.updateThread("x", current => current), () => store.getVerification("x", "p"),
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
  for (const name of ["threads", "verifications", "threadItems", "repositories", "worktrees", "contentIdentities", "gitBlobAliases", "fileMetadata", "fileVersions", "manifests", "privacyPlans", "fileMutations"]) assert.ok(store[name].size <= 1, name);
  store.close();
  for (const name of ["threads", "verifications", "threadItems", "repositories", "worktrees", "contentIdentities", "gitBlobAliases", "fileMetadata", "fileVersions", "manifests", "privacyPlans", "fileMutations"]) assert.equal(store[name].size, 0);
});

test("memory fallback batches large-limit eviction while staying bounded", () => {
  const store = new MemoryContextVerificationStore({ maxLedgerItems: 20 });
  for (let index = 0; index < 21; index += 1) {
    store.registerRepository({
      repositoryId: hash(`batch-repository-${index}`),
      rootRef: hash(`batch-root-${index}`)
    });
  }
  assert.equal(store.repositories.size, 18);
  store.close();
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

test("database-backed geometry requires every non-null integer before storage", async t => {
  const sqlite = (await opened(t)).store;
  const memory = new MemoryContextVerificationStore();
  t.after(() => memory.close());

  for (const store of [sqlite, memory]) {
    assert.throws(() => store.putPrivacyPlan({
      contentHash: hash("required-content"),
      policyFingerprint: hash("required-policy"),
      spans: [{ end: 1, classification: "token", reference: hash("span") }],
      editPlan: []
    }), /range start is required/);

    assert.throws(() => store.stageFileMutation({
      mutationId: hash("required-mutation"),
      worktreeId: hash("required-worktree"),
      pathHash: hash("required-path"),
      expectedContentHash: hash("required-old"),
      nextContentHash: hash("required-new"),
      opaqueReference: hash("required-ref"),
      edits: [{ start: 0, end: 0 }]
    }), /inserted length is required/);

    assert.throws(() => store.stageFileMutation({
      mutationId: hash("required-insertion"),
      worktreeId: hash("required-worktree"),
      pathHash: hash("required-path"),
      expectedContentHash: hash("required-old"),
      nextContentHash: hash("required-new"),
      opaqueReference: hash("required-ref"),
      edits: [{
        start: 0,
        end: 0,
        insertedLength: 1,
        knownInsertions: [{ length: 1, reference: hash("insertion") }]
      }]
    }), /insertion offset is required/);
  }

  assert.equal(sqlite.database.prepare("SELECT COUNT(*) AS count FROM ledger_privacy_plans").get().count, 0);
  assert.equal(sqlite.database.prepare("SELECT COUNT(*) AS count FROM ledger_file_mutations").get().count, 0);
  assert.equal(memory.privacyPlans.size, 0);
  assert.equal(memory.fileMutations.size, 0);
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
    return error?.code === "PRIVACYAI_CONTEXT_DB_CORRUPT" && !diagnostic.includes(secret);
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

test("mutation commit and rollback transitions serialize across handles", async t => {
  const { path, store: first } = await opened(t);
  const second = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => second.close());
  first.registerRepository({ repositoryId: hash("transition-repo"), rootRef: hash("transition-root") });
  first.registerWorktree({
    worktreeId: hash("transition-worktree"),
    repositoryId: hash("transition-repo"),
    pathHash: hash("transition-worktree-path"),
    metadataRef: hash("transition-meta")
  });
  first.stageFileMutation({
    mutationId: hash("transition-mutation"),
    worktreeId: hash("transition-worktree"),
    pathHash: hash("transition-path"),
    expectedContentHash: hash("transition-old"),
    nextContentHash: hash("transition-new"),
    opaqueReference: hash("transition-operation")
  });

  assert.equal(
    first.commitFileMutation(
      hash("transition-mutation"),
      hash("transition-new"),
      hash("transition-commit-a")
    ).status,
    "committed"
  );
  assert.deepEqual(
    second.commitFileMutation(
      hash("transition-mutation"),
      hash("transition-new"),
      hash("transition-commit-b")
    ),
    { status: "conflict", reason: "committed_reference_conflict" }
  );
  assert.deepEqual(
    second.rollbackFileMutation(hash("transition-mutation")),
    { status: "conflict", reason: "already_committed" }
  );
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
