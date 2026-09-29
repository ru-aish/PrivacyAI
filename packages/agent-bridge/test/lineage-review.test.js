import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeEvent,
  normalizeMetadata,
  opaqueIdentity,
  openLineageRepository
} from "../src/lineage/index.js";
import { initializeLineageSchema } from "../src/lineage/schema.js";
import { isSqliteContention, retryLineageContention, sanitizedContentionCause } from "../src/lineage/retry.js";

const opaque = (namespace, character) => `${namespace}:${character.repeat(32)}`;

test("rejects a symlink component before recursive mkdir creates through it", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-precreate-symlink-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const real = join(root, "real");
  await mkdir(real, { mode: 0o700 });
  const linked = join(root, "linked");
  await symlink(real, linked);
  const escapedDirectory = join(real, "must-not-be-created");

  await assert.rejects(
    () => openLineageRepository({
      lineageDbPath: join(linked, "must-not-be-created", "lineage.sqlite3")
    }),
    error => error?.code === "PRIVACYAI_LINEAGE_UNSAFE_PATH"
  );
  await assert.rejects(
    () => stat(escapedDirectory),
    error => error?.code === "ENOENT"
  );
});

test("schema initialization contention is handled by the public open retry boundary", () => {
  const busy = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR"
  });
  const database = {
    exec(statement) {
      if (statement === "BEGIN IMMEDIATE" || statement === "ROLLBACK") return;
      throw new Error(`unexpected statement: ${statement}`);
    },
    prepare() {
      throw busy;
    }
  };

  assert.throws(
    () => initializeLineageSchema(database),
    error => error === busy
  );
});

test("validation diagnostics never echo unknown input-derived names", () => {
  const privateName = "private-field-name-DO-NOT-LOG";
  assert.throws(
    () => normalizeEvent({
      sessionId: opaque("session", "a"),
      eventType: "session_created",
      reasonCode: "session_start",
      [privateName]: true
    }),
    error =>
      error?.code === "PRIVACYAI_LINEAGE_INVALID_EVENT" &&
      !error.message.includes(privateName)
  );
  assert.throws(
    () => normalizeMetadata({ [privateName]: true }),
    error =>
      error?.code === "PRIVACYAI_LINEAGE_INVALID_EVENT" &&
      !error.message.includes(privateName)
  );
  assert.throws(
    () => opaqueIdentity("invalid", privateName),
    error =>
      error?.code === "PRIVACYAI_LINEAGE_INVALID_EVENT" &&
      !error.message.includes(privateName)
  );
});

test("closed repositories fail before traversal argument validation", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-closed-traversal-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const repository = await openLineageRepository({
    lineageDbPath: join(root, "lineage.sqlite3")
  });
  repository.close();

  for (const operation of [
    () => repository.sessionTraversal(opaque("session", "a"), { limit: 0 }),
    () => repository.valueTraversal(opaque("value", "b"), { limit: 0 })
  ]) {
    assert.throws(
      operation,
      error => error?.code === "PRIVACYAI_LINEAGE_CLOSED"
    );
  }
});

test("busy timeout is bounded and nested SQLite lock errors retain only a conventional sanitized code", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-busy-options-"));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: join(root, "lineage.sqlite3"), lineageBusyTimeoutMs: 101 }),
    error => error?.code === "PRIVACYAI_LINEAGE_INVALID_OPTIONS"
  );
  const nested = { cause: { code: "ERR_SQLITE_ERROR", message: "private table is locked: raw-secret" } };
  assert.equal(isSqliteContention(nested), true);
  const cause = sanitizedContentionCause(nested);
  assert.equal(cause.code, "SQLITE_LOCKED");
  assert.equal(cause.message.includes("raw-secret"), false);
});

test("retry rejects already-aborted signals and removes its abort listener", async () => {
  const already = new AbortController(); already.abort();
  await assert.rejects(
    () => retryLineageContention(() => { throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" }); }, { timeoutMs: 100, signal: already.signal }),
    error => error?.code === "PRIVACYAI_LINEAGE_ABORTED"
  );
  let adds = 0; let removes = 0;
  const signal = {
    aborted: false,
    addEventListener() { adds += 1; },
    removeEventListener() { removes += 1; }
  };
  let attempts = 0;
  await retryLineageContention(() => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
    return "ok";
  }, { timeoutMs: 100, signal });
  assert.equal(adds, 1);
  assert.equal(removes, 1);
});
