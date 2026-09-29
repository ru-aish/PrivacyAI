import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCliInspectionService } from "../src/cli-inspection.js";

test("CLI inspection fails safely without creating missing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-inspection-missing-"));
  const path = join(root, "missing.sqlite3");
  try {
    await assert.rejects(
      createCliInspectionService({ verificationDbPath: path }),
      error => error?.code === "PRIVACYAI_INSPECTION_UNAVAILABLE" &&
        /not initialized; nothing to inspect/.test(error.message)
    );
    await assert.rejects(access(path), error => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI inspection returns metadata without stored originals", async t => {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("node:sqlite is unavailable");
      return;
    }
    throw error;
  }

  const root = await mkdtemp(join(tmpdir(), "privacyai-inspection-"));
  const path = join(root, "context.sqlite3");
  const original = "private@example.test";
  let database;
  try {
    database = new sqlite.DatabaseSync(path);
    database.exec(`
      CREATE TABLE privacyai_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE threads(
        session_key TEXT PRIMARY KEY,
        parent_keys_json TEXT NOT NULL,
        session_map_json TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE verified_items(
        cache_key TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        additions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL
      );
      CREATE TABLE thread_items(
        session_key TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE ledger_worktrees(worktree_id TEXT PRIMARY KEY);
      CREATE TABLE ledger_manifests(manifest_hash TEXT PRIMARY KEY);
      CREATE TABLE ledger_file_mutations(
        mutation_id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        path_hash TEXT NOT NULL,
        expected_content_hash TEXT NOT NULL,
        next_content_hash TEXT NOT NULL,
        manifest_hash TEXT,
        status TEXT NOT NULL,
        opaque_reference TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        source_length INTEGER,
        next_length INTEGER,
        committed_reference TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
    `);
    database.prepare("INSERT INTO privacyai_meta(key,value) VALUES('schema_version','3')").run();
    database.prepare(`
      INSERT INTO threads(session_key,parent_keys_json,session_map_json,policy_fingerprint,updated_at)
      VALUES(?,?,?,?,?)
    `).run("session-hash", "[]", JSON.stringify({ "[EMAIL_1]": original }), "policy-hash", 10);
    database.prepare(`
      INSERT INTO verified_items(cache_key,content_hash,artifact_type,policy_fingerprint,additions_json,created_at,last_used_at,hit_count)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      "cache-hash",
      "content-hash",
      "prompt",
      "policy-hash",
      JSON.stringify({ "[EMAIL_1]": original }),
      1,
      2,
      3
    );
    database.prepare(`
      INSERT INTO thread_items(session_key,slot_key,cache_key,content_hash,artifact_type,last_seen_at)
      VALUES(?,?,?,?,?,?)
    `).run("session-hash", "slot-hash", "cache-hash", "content-hash", "prompt", 11);
    database.prepare(`
      INSERT INTO ledger_file_mutations(
        mutation_id,worktree_id,path_hash,expected_content_hash,next_content_hash,
        manifest_hash,status,opaque_reference,operation_type,source_length,next_length,
        committed_reference,created_at,last_used_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      "mutation-hash", "worktree-hash", "path-hash", "before-hash", "after-hash",
      null, "committed", "opaque-ref", "write", 10, 11, "commit-ref", 12, 13
    );
    database.close();
    database = null;

    const service = await createCliInspectionService({ verificationDbPath: path });
    const cache = service.inspectCache({ action: "show", key: "cache-hash" });
    const lineage = service.inspectLineage({ action: "show", key: "session-hash", limit: 10 });
    const mutations = service.inspectLineage({ action: "mutations", limit: 10 });
    service.close();

    assert.equal(cache.entry.additionCount, 1);
    assert.equal(lineage.session.mapping_count, 1);
    assert.equal(lineage.session.items.length, 1);
    assert.equal(mutations.mutations[0].mutation_id, "mutation-hash");
    const serialized = JSON.stringify({ cache, lineage, mutations });
    assert.equal(serialized.includes(original), false);
    assert.equal(serialized.includes("[EMAIL_1]"), false);
  } finally {
    try {
      database?.close();
    } catch {
      // Cleanup only.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI inspection fails closed for corrupt persisted JSON metadata", async t => {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("node:sqlite is unavailable");
      return;
    }
    throw error;
  }

  const cases = [
    {
      name: "parent_keys_json",
      corrupt(database, privateValue) {
        database.prepare("UPDATE threads SET parent_keys_json = ? WHERE session_key = ?")
          .run(privateValue, "session-hash");
      },
      inspect(service) {
        return service.inspectLineage({ action: "show", key: "session-hash" });
      }
    },
    {
      name: "session_map_json",
      corrupt(database, privateValue) {
        database.prepare("UPDATE threads SET session_map_json = ? WHERE session_key = ?")
          .run(privateValue, "session-hash");
      },
      inspect(service) {
        return service.inspectLineage({ action: "show", key: "session-hash" });
      }
    },
    {
      name: "additions_json",
      corrupt(database, privateValue) {
        database.prepare("UPDATE verified_items SET additions_json = ? WHERE cache_key = ?")
          .run(privateValue, "cache-hash");
      },
      inspect(service) {
        return service.inspectCache({ action: "show", key: "cache-hash" });
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), `privacyai-inspection-corrupt-${scenario.name}-`));
      const path = join(root, "context.sqlite3");
      const privateValue = `not-json-private-${scenario.name}`;
      let database;
      let service;
      try {
        database = new sqlite.DatabaseSync(path);
        database.exec(`
          CREATE TABLE privacyai_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE threads(
            session_key TEXT PRIMARY KEY,
            parent_keys_json TEXT NOT NULL,
            session_map_json TEXT NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE verified_items(
            cache_key TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            artifact_type TEXT NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            additions_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            hit_count INTEGER NOT NULL
          );
          CREATE TABLE thread_items(
            session_key TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            cache_key TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            artifact_type TEXT NOT NULL,
            last_seen_at INTEGER NOT NULL
          );
          CREATE TABLE ledger_worktrees(worktree_id TEXT PRIMARY KEY);
          CREATE TABLE ledger_manifests(manifest_hash TEXT PRIMARY KEY);
          CREATE TABLE ledger_file_mutations(mutation_id TEXT PRIMARY KEY);
        `);
        database.prepare("INSERT INTO privacyai_meta(key,value) VALUES('schema_version','3')").run();
        database.prepare(`
          INSERT INTO threads(session_key,parent_keys_json,session_map_json,policy_fingerprint,updated_at)
          VALUES(?,?,?,?,?)
        `).run("session-hash", "[]", "{}", "policy-hash", 10);
        database.prepare(`
          INSERT INTO verified_items(cache_key,content_hash,artifact_type,policy_fingerprint,additions_json,created_at,last_used_at,hit_count)
          VALUES(?,?,?,?,?,?,?,?)
        `).run("cache-hash", "content-hash", "prompt", "policy-hash", "{}", 1, 2, 3);
        scenario.corrupt(database, privateValue);
        database.close();
        database = null;

        service = await createCliInspectionService({ verificationDbPath: path });
        assert.throws(
          () => scenario.inspect(service),
          error =>
            error?.code === "PRIVACYAI_INSPECTION_CORRUPT" &&
            error.message === "PrivacyAI local state contains invalid inspection metadata." &&
            !error.message.includes(privateValue) &&
            !error.message.includes(path)
        );
      } finally {
        service?.close();
        try {
          database?.close();
        } catch {
          // Cleanup only.
        }
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("CLI inspection reads pre-v3 mutations without requiring a writable migration", async t => {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("node:sqlite is unavailable");
      return;
    }
    throw error;
  }

  const root = await mkdtemp(join(tmpdir(), "privacyai-inspection-v2-"));
  const path = join(root, "context.sqlite3");
  let database;
  try {
    database = new sqlite.DatabaseSync(path);
    database.exec(`
      CREATE TABLE privacyai_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO privacyai_meta VALUES('schema_version', '2');
      CREATE TABLE threads(session_key TEXT PRIMARY KEY, parent_keys_json TEXT, session_map_json TEXT, policy_fingerprint TEXT, updated_at INTEGER);
      CREATE TABLE verified_items(cache_key TEXT PRIMARY KEY, content_hash TEXT, artifact_type TEXT, policy_fingerprint TEXT, additions_json TEXT, created_at INTEGER, last_used_at INTEGER, hit_count INTEGER);
      CREATE TABLE thread_items(session_key TEXT, slot_key TEXT, cache_key TEXT, content_hash TEXT, artifact_type TEXT, last_seen_at INTEGER);
      CREATE TABLE ledger_worktrees(worktree_id TEXT PRIMARY KEY);
      CREATE TABLE ledger_manifests(manifest_hash TEXT PRIMARY KEY);
      CREATE TABLE ledger_file_mutations(
        mutation_id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        path_hash TEXT NOT NULL,
        expected_content_hash TEXT NOT NULL,
        next_content_hash TEXT NOT NULL,
        manifest_hash TEXT,
        status TEXT NOT NULL,
        opaque_reference TEXT NOT NULL,
        committed_reference TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      INSERT INTO ledger_file_mutations VALUES(
        'mutation-v2', 'worktree-v2', 'path-v2', 'before-v2', 'after-v2',
        NULL, 'committed', 'opaque-v2', 'commit-v2', 1, 2
      );
    `);
    database.close();
    database = null;

    const service = await createCliInspectionService({ verificationDbPath: path });
    const result = service.inspectLineage({ action: "mutations", limit: 10 });
    service.close();

    assert.deepEqual(result.mutations, [{
      mutation_id: "mutation-v2",
      worktree_id: "worktree-v2",
      path_hash: "path-v2",
      expected_content_hash: "before-v2",
      next_content_hash: "after-v2",
      manifest_hash: null,
      status: "committed",
      opaque_reference: "opaque-v2",
      operation_type: "unknown",
      source_length: null,
      next_length: null,
      committed_reference: "commit-v2",
      created_at: 1,
      last_used_at: 2
    }]);
  } finally {
    try {
      database?.close();
    } catch {
      // Cleanup only.
    }

    await rm(root, { recursive: true, force: true });
  }
});
