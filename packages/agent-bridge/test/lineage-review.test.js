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

import { openLineageRepository } from "../src/lineage/index.js";
import { initializeLineageSchema } from "../src/lineage/schema.js";

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

test("schema initialization retains a safe SQLite contention cause", () => {
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
    error =>
      error?.code === "PRIVACYAI_LINEAGE_SCHEMA_INVALID" &&
      error?.cause?.code === "SQLITE_LOCKED" &&
      !error.message.includes("locked")
  );
});
