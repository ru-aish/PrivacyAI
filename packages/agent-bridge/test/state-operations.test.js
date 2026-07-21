import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  createOperationalStateBackup,
  inspectOperationalState,
  migrateOperationalState,
  planOperationalStateUpgrade,
  repairOperationalState,
  restoreOperationalStateBackup
} from "../src/state-operations.js";
import { loadPrivacyConfig, savePrivacyConfig } from "../src/config-store.js";
import { openContextVerificationStore } from "../src/context-repository/index.js";
import {
  openInstallationPrivacyIdentity,
  rotateInstallationPrivacyIdentityKey
} from "../src/privacy-identity.js";
import { SessionVault } from "../src/session-vault.js";

const CONFIG = Object.freeze({
  provider: "ollama",
  model: "local-model",
  baseURL: "http://127.0.0.1:11434"
});

function paths(root) {
  return {
    configPath: join(root, "config", "config.json"),
    identityKeyPath: join(root, "identity", "key-v1.json"),
    vaultDir: join(root, "vault"),
    contextDbPath: join(root, "context.sqlite3"),
    lineageDbPath: join(root, "lineage.sqlite3")
  };
}

async function fixture(t, prefix = "privacyai-state-operations-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, paths: paths(root) };
}

async function createCurrentState(statePaths, options = {}) {
  await savePrivacyConfig(CONFIG, { path: statePaths.configPath });
  const identity = await openInstallationPrivacyIdentity({ identityKeyPath: statePaths.identityKeyPath });
  if (options.vault !== false) {
    await new SessionVault({ baseDir: statePaths.vaultDir, identityRoot: identity })
      .save("session-a", { "[EMAIL_1]": "owner@example.test" });
  }
  if (options.context !== false) {
    const context = await openContextVerificationStore({ verificationDbPath: statePaths.contextDbPath });
    context.close();
  }
  return identity;
}

async function createLegacyState(statePaths) {
  await mkdir(join(statePaths.configPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(statePaths.configPath, JSON.stringify(CONFIG) + "\n", { mode: 0o600 });
  const identity = await openInstallationPrivacyIdentity({ identityKeyPath: statePaths.identityKeyPath });
  await mkdir(statePaths.vaultDir, { recursive: true, mode: 0o700 });
  const sessionId = "legacy-session";
  const legacyFile = createHash("sha256").update(sessionId).digest("hex") + ".json";
  await writeFile(join(statePaths.vaultDir, legacyFile), JSON.stringify({
    version: 1,
    sessionId,
    sessionMap: { "[TOKEN_1]": "private-legacy-token" },
    updatedAt: "2026-01-01T00:00:00.000Z"
  }) + "\n", { mode: 0o600 });
  const context = await openContextVerificationStore({ verificationDbPath: statePaths.contextDbPath });
  context.close();
  const sqlite = await import("node:sqlite");
  const database = new sqlite.DatabaseSync(statePaths.contextDbPath);
  database.prepare("UPDATE privacyai_meta SET value = '3' WHERE key = 'schema_version'").run();
  database.close();
  return { identity, sessionId, legacyFile };
}

function byName(report, name) {
  return report.components.find(component => component.name === name);
}

test("preflight is read-only and reports uninitialized state with actionable onboarding", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-empty-");
  const before = await treeSnapshot(root);
  const report = await inspectOperationalState(statePaths);
  const plan = await planOperationalStateUpgrade(statePaths);
  const after = await treeSnapshot(root);

  assert.equal(report.ready, false);
  assert.equal(report.canBackup, true);
  assert.equal(report.migrationRequired, false);
  assert.equal(byName(report, "configuration").status, "uninitialized");
  assert.match(report.nextSteps.join("\n"), /privacyai onboard/);
  assert.equal(plan.backupRequired, false);
  assert.deepEqual(after, before);
});

test("preflight identifies only supported explicit migrations and never exposes protected values", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-legacy-");
  await createLegacyState(statePaths);
  const before = await treeSnapshot(root);
  const report = await inspectOperationalState(statePaths);
  const plan = await planOperationalStateUpgrade(statePaths);
  const serialized = JSON.stringify({ report, plan });

  assert.equal(report.migrationRequired, true);
  assert.equal(report.canMigrate, true);
  assert.equal(byName(report, "configuration").status, "migration_required");
  assert.equal(byName(report, "vault").status, "migration_required");
  assert.equal(byName(report, "context").status, "migration_required");
  assert.deepEqual(plan.actions.filter(action => action.action === "migrate").map(action => action.component), [
    "configuration", "vault", "context"
  ]);
  assert.doesNotMatch(serialized, /private-legacy-token|TOKEN_1|local-model|127\.0\.0\.1/);
  assert.deepEqual(await treeSnapshot(root), before);
});

test("migration creates a verified backup, preserves installation identity, and upgrades config, vault, and context atomically", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-migrate-");
  const { identity, sessionId, legacyFile } = await createLegacyState(statePaths);
  const keyBefore = await readFile(statePaths.identityKeyPath);
  const backupDir = join(root, "backups", "before-upgrade");

  const migrated = await migrateOperationalState({ ...statePaths, backupDir });
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.migrated, ["configuration", "context", "vault"]);
  assert.equal(migrated.state.migrationRequired, false);
  assert.deepEqual(await readFile(statePaths.identityKeyPath), keyBefore);

  const config = JSON.parse(await readFile(statePaths.configPath, "utf8"));
  assert.equal(config.version, 1);
  const locator = JSON.parse(await readFile(join(statePaths.vaultDir, legacyFile), "utf8"));
  assert.equal(locator.kind, "privacyai-vault-locator");
  assert.match(locator.file, /^v2-[a-f0-9]{64}\.json$/);
  const restored = await new SessionVault({ baseDir: statePaths.vaultDir, identityRoot: identity }).load(sessionId);
  assert.equal(restored.sessionMap["[TOKEN_1]"], "private-legacy-token");

  const sqlite = await import("node:sqlite");
  const context = new sqlite.DatabaseSync(statePaths.contextDbPath, { readOnly: true });
  assert.equal(context.prepare("SELECT value FROM privacyai_meta WHERE key='schema_version'").get().value, "4");
  context.close();

  const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
  assert.equal(manifest.components.identity.file, "identity/key-v1.json");
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(backupDir, "manifest.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(join(backupDir, "identity", "key-v1.json")), keyBefore);
});

test("backup is consistent, private, cancellable, and does not create a partial destination", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-backup-");
  await createCurrentState(statePaths);
  const backupDir = join(root, "backup", "snapshot");
  const result = await createOperationalStateBackup({ ...statePaths, backupDir });
  assert.deepEqual(result.components, ["configuration", "identity", "vault", "context"]);
  const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
  for (const entry of Object.values(manifest.components)) {
    if (entry.files) {
      for (const file of entry.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
    } else {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
  }

  const controller = new AbortController();
  controller.abort();
  const cancelled = join(root, "backup", "cancelled");
  await assert.rejects(
    createOperationalStateBackup({ ...statePaths, backupDir: cancelled, signal: controller.signal }),
    error => error?.name === "AbortError"
  );
  await assert.rejects(access(cancelled), error => error?.code === "ENOENT");

  let checks = 0;
  const interruption = new Error("test interruption");
  interruption.name = "AbortError";
  const signal = {
    get aborted() {
      checks += 1;
      return checks >= 5;
    },
    reason: interruption
  };
  const interrupted = join(root, "backup", "interrupted");
  await assert.rejects(
    createOperationalStateBackup({ ...statePaths, backupDir: interrupted, signal }),
    error => error === interruption
  );
  await assert.rejects(access(interrupted), error => error?.code === "ENOENT");
  assert.deepEqual(
    (await readdir(join(root, "backup"))).filter(name => name.includes("interrupted")),
    []
  );
});

test("SQLite backup write failures are not misreported as active-database contention", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-sqlite-backup-failure-");
  await createCurrentState(statePaths, { vault: false });
  const backupParent = join(root, "backups");
  const backupDir = join(backupParent, "snapshot");
  let injected = false;
  const signal = {
    get aborted() {
      if (!injected && existsSync(backupParent)) {
        const stage = readdirSync(backupParent)
          .find(name => name.startsWith(".snapshot.") && name.endsWith(".tmp"));
        if (stage) {
          mkdirSync(join(backupParent, stage, "context.sqlite3"));
          injected = true;
        }
      }
      return false;
    },
    reason: null
  };

  await assert.rejects(
    createOperationalStateBackup({ ...statePaths, backupDir, signal }),
    error => error?.code === "PRIVACYAI_STATE_BACKUP_FAILED" &&
      !error.publicMessage.includes(statePaths.contextDbPath)
  );
  assert.equal(injected, true);
  await assert.rejects(access(backupDir), error => error?.code === "ENOENT");
});

test("repair is backup-first and only fixes bounded permissions and interrupted vault artifacts", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-repair-");
  await createCurrentState(statePaths);
  await chmod(statePaths.configPath, 0o644);
  await chmod(statePaths.identityKeyPath, 0o644);
  const staleLock = join(statePaths.vaultDir, "stale.json.lock");
  await writeFile(staleLock, "not-a-live-lock\n", { mode: 0o600 });
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await (await import("node:fs/promises")).utimes(staleLock, old, old);

  const before = await inspectOperationalState(statePaths);
  assert.equal(byName(before, "configuration").status, "repair_required");
  assert.equal(byName(before, "identity").status, "repair_required");
  assert.equal(byName(before, "vault").status, "repair_required");

  const backupDir = join(root, "repair-backup");
  const repaired = await repairOperationalState({ ...statePaths, backupDir });
  assert.deepEqual(repaired.repaired, ["configuration", "identity", "vault"]);
  assert.equal((await stat(statePaths.configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(statePaths.identityKeyPath)).mode & 0o777, 0o600);
  await assert.rejects(access(staleLock), error => error?.code === "ENOENT");
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
});

test("restore requires explicit replacement and a separate installation-identity acknowledgement", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-restore-");
  const initialIdentity = await createCurrentState(statePaths);
  const initialKey = await readFile(statePaths.identityKeyPath);
  const backupDir = join(root, "restore-source");
  await createOperationalStateBackup({ ...statePaths, backupDir });

  await savePrivacyConfig({ ...CONFIG, model: "changed-model" }, { path: statePaths.configPath });
  const rotated = await rotateInstallationPrivacyIdentityKey({ identityKeyPath: statePaths.identityKeyPath });
  await new SessionVault({ baseDir: statePaths.vaultDir, identityRoot: rotated.identityRoot })
    .save("session-a", { "[EMAIL_1]": "changed@example.test" });

  await assert.rejects(
    restoreOperationalStateBackup({ ...statePaths, backupDir }),
    error => error?.code === "PRIVACYAI_STATE_RESTORE_REPLACE_REQUIRED"
  );
  await assert.rejects(
    restoreOperationalStateBackup({ ...statePaths, backupDir, replace: true }),
    error => error?.code === "PRIVACYAI_STATE_IDENTITY_REPLACE_REQUIRED"
  );

  const restored = await restoreOperationalStateBackup({
    ...statePaths,
    backupDir,
    replace: true,
    replaceIdentity: true
  });
  assert.equal(restored.identityReplaced, true);
  assert.deepEqual(await readFile(statePaths.identityKeyPath), initialKey);
  const config = JSON.parse(await readFile(statePaths.configPath, "utf8"));
  assert.equal(config.model, "local-model");
  const vault = await new SessionVault({ baseDir: statePaths.vaultDir, identityRoot: initialIdentity }).load("session-a");
  assert.equal(vault.sessionMap["[EMAIL_1]"], "owner@example.test");
});

test("restoring the same installation identity repairs its file without requiring identity replacement", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-same-identity-restore-");
  await createCurrentState(statePaths, { vault: false, context: false });
  const keyBefore = await readFile(statePaths.identityKeyPath);
  const backupDir = join(root, "backup");
  await createOperationalStateBackup({ ...statePaths, backupDir });
  await chmod(statePaths.identityKeyPath, 0o644);

  const restored = await restoreOperationalStateBackup({
    ...statePaths,
    backupDir,
    replace: true
  });
  assert.equal(restored.identityReplaced, false);
  assert.ok(restored.restored.includes("identity"));
  assert.deepEqual(await readFile(statePaths.identityKeyPath), keyBefore);
  assert.equal((await stat(statePaths.identityKeyPath)).mode & 0o777, 0o600);
});

test("newer, corrupt, symlinked, and hard-linked state blocks all automatic backup without leaking private bytes", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-blockers-");
  await mkdir(join(statePaths.configPath, ".."), { recursive: true, mode: 0o700 });
  const secret = "do-not-print-this-secret@example.test";
  await writeFile(statePaths.configPath, JSON.stringify({ version: 999, secret }) + "\n", { mode: 0o600 });
  const report = await inspectOperationalState(statePaths);
  assert.equal(byName(report, "configuration").status, "unsupported");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret.replaceAll(".", "\\.")));
  await assert.rejects(
    createOperationalStateBackup({ ...statePaths, backupDir: join(root, "blocked-backup") }),
    error => error?.code === "PRIVACYAI_STATE_BACKUP_BLOCKED" && !error.publicMessage.includes(secret)
  );

  await rm(statePaths.configPath);
  const target = join(root, "private-target.json");
  await writeFile(target, JSON.stringify(CONFIG), { mode: 0o600 });
  await symlink(target, statePaths.configPath);
  assert.equal(byName(await inspectOperationalState(statePaths), "configuration").status, "unsafe");

  await rm(statePaths.configPath);
  await link(target, statePaths.configPath);
  assert.equal(byName(await inspectOperationalState(statePaths), "configuration").status, "unsafe");
});

test("backup validation rejects unlisted vault files even when their JSON shape is otherwise valid", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-manifest-");
  await createCurrentState(statePaths);
  const backupDir = join(root, "backup");
  await createOperationalStateBackup({ ...statePaths, backupDir });
  const files = await readdir(join(backupDir, "vault"));
  const record = files.find(file => /^v2-/.test(file));
  assert.ok(record);
  const injected = `v2-${"a".repeat(64)}.json`;
  await writeFile(
    join(backupDir, "vault", injected),
    await readFile(join(backupDir, "vault", record)),
    { mode: 0o600 }
  );

  const emptyPaths = paths(join(root, "restore-target"));
  await assert.rejects(
    restoreOperationalStateBackup({ ...emptyPaths, backupDir }),
    error => error?.code === "PRIVACYAI_STATE_BACKUP_INVALID"
  );
  await assert.rejects(access(emptyPaths.identityKeyPath), error => error?.code === "ENOENT");
});

test("missing installation identity blocks existing v2 state without misclassifying its unbound filename as corruption", async t => {
  const { paths: statePaths } = await fixture(t, "privacyai-state-missing-identity-v2-");
  await createCurrentState(statePaths, { context: false });
  const legacyFile = createHash("sha256").update("session-a").digest("hex") + ".json";
  await rm(join(statePaths.vaultDir, legacyFile));
  await rm(statePaths.identityKeyPath);

  const report = await inspectOperationalState(statePaths);
  assert.equal(byName(report, "identity").status, "blocked");
  assert.equal(byName(report, "vault").status, "ready");
  assert.equal(byName(report, "vault").recordCount, 1);
  assert.equal(report.canBackup, false);
});

test("preflight rejects orphaned v2 vault records that are not identity-bound or locator-bound", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-orphan-vault-");
  await createCurrentState(statePaths, { context: false });
  const orphanFile = `v2-${"b".repeat(64)}.json`;
  await writeFile(join(statePaths.vaultDir, orphanFile), JSON.stringify({
    version: 2,
    sessionId: "orphan-session",
    sessionMap: {},
    identityMap: {},
    identityKeyId: null,
    identityScope: null,
    updatedAt: "2026-07-21T00:00:00.000Z"
  }) + "\n", { mode: 0o600 });

  const report = await inspectOperationalState(statePaths);
  assert.equal(byName(report, "vault").status, "corrupt");
  await assert.rejects(
    createOperationalStateBackup({ ...statePaths, backupDir: join(root, "blocked-backup") }),
    error => error?.code === "PRIVACYAI_STATE_BACKUP_BLOCKED"
  );
});

test("repair is an explicit prerequisite when repair and migration are both required", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-repair-before-migrate-");
  await createLegacyState(statePaths);
  const staleLock = join(statePaths.vaultDir, "interrupted.json.lock");
  await writeFile(staleLock, "{partial", { mode: 0o600 });
  const old = new Date(Date.now() - 60 * 1000);
  await utimes(staleLock, old, old);

  const before = await inspectOperationalState(statePaths);
  assert.equal(before.migrationRequired, true);
  assert.equal(before.repairRequired, true);
  assert.equal(before.canMigrate, false);
  await assert.rejects(
    migrateOperationalState({ ...statePaths, backupDir: join(root, "blocked-migration") }),
    error => error?.code === "PRIVACYAI_STATE_MIGRATION_BLOCKED"
  );
  await assert.rejects(access(join(root, "blocked-migration")), error => error?.code === "ENOENT");

  await repairOperationalState({ ...statePaths, backupDir: join(root, "repair-backup") });
  const afterRepair = await inspectOperationalState(statePaths);
  assert.equal(afterRepair.repairRequired, false);
  assert.equal(afterRepair.migrationRequired, true);
  assert.equal(afterRepair.canMigrate, true);
  await migrateOperationalState({ ...statePaths, backupDir: join(root, "migration-backup") });
  assert.equal((await inspectOperationalState(statePaths)).ready, true);
});

test("normal startup rejects newer configuration and vault versions instead of silently normalizing them", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-startup-version-");
  await mkdir(join(statePaths.configPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(statePaths.configPath, JSON.stringify({ ...CONFIG, version: 2 }) + "\n", { mode: 0o600 });
  await assert.rejects(
    loadPrivacyConfig({ path: statePaths.configPath }),
    error => error?.code === "PRIVACYAI_CONFIG_INVALID" && !error.message.includes("local-model")
  );

  await mkdir(statePaths.vaultDir, { recursive: true, mode: 0o700 });
  const sessionId = "future-session";
  const file = createHash("sha256").update(sessionId).digest("hex") + ".json";
  await writeFile(join(statePaths.vaultDir, file), JSON.stringify({
    version: 99,
    sessionId,
    sessionMap: { "[TOKEN_1]": "future-secret" }
  }) + "\n", { mode: 0o600 });
  await assert.rejects(
    new SessionVault({ baseDir: statePaths.vaultDir }).load(sessionId),
    error => error?.code === "PRIVACYAI_VAULT_CORRUPT" && !error.message.includes("future-secret")
  );
});

test("normal vault updates refuse to silently migrate legacy records", async t => {
  const { paths: statePaths } = await fixture(t, "privacyai-state-explicit-vault-migration-");
  const { identity, sessionId, legacyFile } = await createLegacyState(statePaths);
  const before = await readFile(join(statePaths.vaultDir, legacyFile));
  const vault = new SessionVault({ baseDir: statePaths.vaultDir, identityRoot: identity });
  await assert.rejects(
    vault.merge(sessionId, { "[EMAIL_1]": "new@example.test" }),
    error => error?.code === "PRIVACYAI_VAULT_MIGRATION_REQUIRED"
  );
  assert.deepEqual(await readFile(join(statePaths.vaultDir, legacyFile)), before);
});

test("migration refuses to overwrite state changed after the verified backup was published", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-concurrent-change-");
  const { legacyFile } = await createLegacyState(statePaths);
  const vaultBefore = await readFile(join(statePaths.vaultDir, legacyFile));
  const backupDir = join(root, "backup");
  let changed = false;
  const signal = {
    get aborted() {
      if (!changed && existsSync(join(backupDir, "manifest.json"))) {
        changed = true;
        writeFileSync(statePaths.configPath, JSON.stringify({
          ...CONFIG,
          model: "concurrent-user-change"
        }) + "\n", { mode: 0o600 });
      }
      return false;
    },
    reason: null
  };

  await assert.rejects(
    migrateOperationalState({ ...statePaths, backupDir, signal }),
    error => error?.code === "PRIVACYAI_STATE_BUSY"
  );
  assert.equal(changed, true);
  assert.equal(JSON.parse(await readFile(statePaths.configPath, "utf8")).model, "concurrent-user-change");
  assert.deepEqual(await readFile(join(statePaths.vaultDir, legacyFile)), vaultBefore);
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
});

test("an active SQLite writer blocks publication after backup and leaves live state unchanged", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-sqlite-busy-");
  const { legacyFile } = await createLegacyState(statePaths);
  const configBefore = await readFile(statePaths.configPath);
  const vaultBefore = await readFile(join(statePaths.vaultDir, legacyFile));
  const sqlite = await import("node:sqlite");
  const writer = new sqlite.DatabaseSync(statePaths.contextDbPath);
  writer.exec("BEGIN IMMEDIATE");
  const backupDir = join(root, "busy-migration-backup");
  try {
    await assert.rejects(
      migrateOperationalState({ ...statePaths, backupDir }),
      error => error?.code === "PRIVACYAI_STATE_BUSY"
    );
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  assert.deepEqual(await readFile(statePaths.configPath), configBefore);
  assert.deepEqual(await readFile(join(statePaths.vaultDir, legacyFile)), vaultBefore);
  const database = new sqlite.DatabaseSync(statePaths.contextDbPath, { readOnly: true });
  assert.equal(database.prepare("SELECT value FROM privacyai_meta WHERE key='schema_version'").get().value, "3");
  database.close();
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
});

test("unsafe vault lock links block inspection and repair rather than being deleted as stale", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-unsafe-lock-");
  await createCurrentState(statePaths);
  const source = join(root, "shared-lock-record");
  await writeFile(source, "not-private-lock-data\n", { mode: 0o600 });
  const lockPath = join(statePaths.vaultDir, "linked.json.lock");
  await link(source, lockPath);

  const report = await inspectOperationalState(statePaths);
  assert.equal(byName(report, "vault").status, "unsafe");
  await assert.rejects(
    repairOperationalState({ ...statePaths, backupDir: join(root, "repair-backup") }),
    error => error?.code === "PRIVACYAI_STATE_REPAIR_BLOCKED"
  );
  assert.equal((await lstat(lockPath)).nlink, 2);
});

test("recent malformed vault locks are busy and only become repairable after the stale interval", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-malformed-lock-");
  await createCurrentState(statePaths);
  const lockPath = join(statePaths.vaultDir, "partial.json.lock");
  await writeFile(lockPath, "{partial", { mode: 0o600 });

  assert.equal(byName(await inspectOperationalState(statePaths), "vault").status, "busy");
  const old = new Date(Date.now() - 60 * 1000);
  await utimes(lockPath, old, old);
  assert.equal(byName(await inspectOperationalState(statePaths), "vault").status, "repair_required");
});

test("a live vault lock blocks migration and backup until the owning process exits", async t => {
  const { root, paths: statePaths } = await fixture(t, "privacyai-state-live-lock-");
  await createLegacyState(statePaths);
  const lock = join(statePaths.vaultDir, "active.json.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "active" }) + "\n", { mode: 0o600 });
  const report = await inspectOperationalState(statePaths);
  assert.equal(byName(report, "vault").status, "busy");
  assert.equal(report.canMigrate, false);
  await assert.rejects(
    createOperationalStateBackup({ ...statePaths, backupDir: join(root, "busy-backup") }),
    error => error?.code === "PRIVACYAI_STATE_BACKUP_BLOCKED"
  );
});

async function treeSnapshot(root) {
  const output = [];
  async function visit(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(full);
      if (entry.isDirectory()) {
        output.push([key, "dir", info.mode & 0o777]);
        await visit(full, key);
      } else if (entry.isSymbolicLink()) {
        output.push([key, "link"]);
      } else {
        const bytes = await readFile(full);
        output.push([key, "file", info.mode & 0o777, createHash("sha256").update(bytes).digest("hex")]);
      }
    }
  }
  await visit(root);
  return output;
}
