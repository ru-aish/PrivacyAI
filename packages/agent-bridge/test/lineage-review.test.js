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
