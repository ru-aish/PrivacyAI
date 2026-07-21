import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createPrivacyError, normalizeSessionMap } from "@privacy-ai/sdk";
import {
  createPrivacyIdentityService,
  privacyIdentityKeyId
} from "@privacy-ai/sdk/identity";

import { defaultConfigPath, normalizeConfig } from "./config-store.js";
import {
  CONTEXT_SCHEMA_VERSION,
  CONTEXT_TABLES
} from "./context-repository/constants.js";
import { initializeSchema } from "./context-repository/schema.js";
import {
  LINEAGE_SCHEMA_VERSION
} from "./lineage/domain.js";
import {
  validateLineageSchema,
  validateSchemaVersion as validateLineageSchemaVersion
} from "./lineage/schema.js";
import { defaultPrivacyIdentityKeyPath } from "./privacy-identity.js";
import { isSameLiveProcess } from "./process-identity.js";
import { SessionVault } from "./session-vault.js";

export const STATE_OPERATIONS_VERSION = 1;
export const STATE_BACKUP_VERSION = 1;

const CONFIG_VERSION = 1;
const IDENTITY_VERSION = 1;
const VAULT_VERSION = 2;
const VAULT_LOCATOR_VERSION = 1;
const VAULT_LOCATOR_KIND = "privacyai-vault-locator";
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_AGE_MS = 30 * 1000;
const BACKUP_KIND = "privacyai-state-backup";
const BLOCKING_BACKUP_STATUSES = new Set([
  "blocked",
  "busy",
  "corrupt",
  "unsafe",
  "unavailable",
  "unsupported"
]);

export function resolveOperationalStatePaths(options = {}) {
  return Object.freeze({
    configPath: resolve(options.configPath || defaultConfigPath()),
    identityKeyPath: resolve(
      options.identityKeyPath ||
      process.env.PRIVACYAI_IDENTITY_KEY_FILE ||
      defaultPrivacyIdentityKeyPath(
        options.identityBaseDir ? { identityBaseDir: options.identityBaseDir } : {}
      )
    ),
    vaultDir: resolve(
      options.vaultDir ||
      process.env.PRIVACYAI_AGENT_VAULT_DIR ||
      join(homedir(), ".local", "share", "privacyai", "agent-sessions")
    ),
    contextDbPath: resolve(
      options.contextDbPath ||
      options.verificationDbPath ||
      process.env.PRIVACYAI_CONTEXT_DB ||
      join(homedir(), ".local", "share", "privacyai", "context-gateway.sqlite3")
    ),
    lineageDbPath: resolve(
      options.lineageDbPath ||
      process.env.PRIVACYAI_LINEAGE_DB ||
      join(homedir(), ".local", "share", "privacyai", "lineage.sqlite3")
    )
  });
}

export async function inspectOperationalState(options = {}) {
  return (await inspectOperationalStateInternal(options)).report;
}

export async function planOperationalStateUpgrade(options = {}) {
  const report = await inspectOperationalState(options);
  const actions = [];
  for (const component of report.components) {
    if (component.status === "migration_required") {
      actions.push({
        component: component.name,
        action: "migrate",
        fromVersion: component.currentVersion,
        toVersion: component.targetVersion
      });
    } else if (component.status === "repair_required") {
      actions.push({ component: component.name, action: "repair" });
    } else if (BLOCKING_BACKUP_STATUSES.has(component.status)) {
      actions.push({ component: component.name, action: "manual_recovery" });
    }
  }
  return Object.freeze({
    version: STATE_OPERATIONS_VERSION,
    ready: report.ready,
    canMigrate: report.canMigrate,
    migrationRequired: report.migrationRequired,
    repairRequired: report.repairRequired,
    backupRequired: actions.some(action => action.action === "migrate" || action.action === "repair"),
    actions,
    nextSteps: report.nextSteps
  });
}

export async function createOperationalStateBackup(options = {}) {
  return (await createOperationalStateBackupInternal(options)).result;
}

async function createOperationalStateBackupInternal(options = {}) {
  const backupDir = requiredPath(options.backupDir, "backupDir");
  throwIfAborted(options.signal);
  const inspected = await inspectOperationalStateInternal(options);
  assertBackupSupported(inspected.report);
  const paths = inspected.paths;
  const sourceComponents = presentComponentNames(inspected.runtime);
  const sourceFingerprint = await captureStateFingerprint(paths, sourceComponents);
  const parent = dirname(backupDir);
  await ensureDirectoryPath(parent, { create: true, privateDirectory: false });
  await assertPathMissing(backupDir, "PrivacyAI backup destination already exists.");

  const stage = join(parent, `.${basename(backupDir)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const components = {};
    if (inspected.runtime.config?.exists) {
      components.configuration = await backupPrivateFile(
        paths.configPath,
        join(stage, "configuration.json"),
        "configuration.json",
        options.signal
      );
    }
    if (inspected.runtime.identity?.exists) {
      await mkdir(join(stage, "identity"), { mode: 0o700 });
      components.identity = await backupPrivateFile(
        paths.identityKeyPath,
        join(stage, "identity", "key-v1.json"),
        "identity/key-v1.json",
        options.signal
      );
    }
    if (inspected.runtime.vault?.exists) {
      components.vault = await backupVault(
        paths.vaultDir,
        join(stage, "vault"),
        inspected.runtime.vault.files,
        options.signal
      );
    }
    if (inspected.runtime.context?.exists) {
      components.context = await backupSqlite(
        paths.contextDbPath,
        join(stage, "context.sqlite3"),
        options.signal
      );
    }
    if (inspected.runtime.lineage?.exists) {
      components.lineage = await backupSqlite(
        paths.lineageDbPath,
        join(stage, "lineage.sqlite3"),
        options.signal
      );
    }

    throwIfAborted(options.signal);
    await assertStateFingerprintUnchanged(paths, sourceComponents, sourceFingerprint);
    const manifest = {
      kind: BACKUP_KIND,
      version: STATE_BACKUP_VERSION,
      createdAt: new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString(),
      components
    };
    await writePrivateJson(join(stage, "manifest.json"), manifest);
    throwIfAborted(options.signal);
    await assertPathMissing(backupDir, "PrivacyAI backup destination already exists.");
    await rename(stage, backupDir);
    return {
      result: Object.freeze({
        version: STATE_OPERATIONS_VERSION,
        backupDir,
        componentCount: Object.keys(components).length,
        components: Object.keys(components)
      }),
      sourceComponents,
      sourceFingerprint
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (isStateError(error) || error?.name === "AbortError") throw error;
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_FAILED",
      "PrivacyAI could not create a complete local-state backup.",
      error,
      "storage_write"
    );
  }
}

export async function restoreOperationalStateBackup(options = {}) {
  const backupDir = requiredPath(options.backupDir, "backupDir");
  throwIfAborted(options.signal);
  const backup = await readAndValidateBackup(backupDir, options.signal);
  const paths = resolveOperationalStatePaths(options);
  const current = await inspectOperationalStateInternal(options);
  assertRestoreDestinations(current, backup, options);
  const guardedComponents = Object.keys(backup.manifest.components);
  const sourceFingerprint = await captureStateFingerprint(paths, guardedComponents);

  const installation = await prepareRestoreInstallation(backup, paths, options);
  let report;
  try {
    report = await installPreparedArtifacts(
      installation,
      options.signal,
      async () => {
        const next = await inspectOperationalState(options);
        if (next.components.some(component =>
          ["corrupt", "unsafe", "unsupported", "unavailable"].includes(component.status)
        )) {
          throw stateError(
            "PRIVACYAI_STATE_RESTORE_FAILED",
            "PrivacyAI restore validation failed. Existing state was restored and the verified backup was preserved.",
            undefined,
            "storage_write"
          );
        }
        return next;
      },
      component => assertStateFingerprintUnchanged(paths, [component], sourceFingerprint)
    );
  } finally {
    await cleanupPreparedArtifacts(installation);
  }
  return Object.freeze({
    version: STATE_OPERATIONS_VERSION,
    backupDir,
    restored: installation.map(item => item.component),
    identityReplaced: installation.some(item => item.component === "identity" && item.identityChanged),
    state: report
  });
}

export async function migrateOperationalState(options = {}) {
  const plan = await planOperationalStateUpgrade(options);
  if (!plan.migrationRequired) {
    return Object.freeze({
      version: STATE_OPERATIONS_VERSION,
      changed: false,
      migrated: [],
      backup: null,
      state: await inspectOperationalState(options)
    });
  }
  if (!plan.canMigrate) {
    throw stateError(
      "PRIVACYAI_STATE_MIGRATION_BLOCKED",
      "PrivacyAI local state cannot be migrated safely. Run `privacyai state preflight` and resolve the reported blocker first."
    );
  }
  const backupDir = requiredPath(options.backupDir, "backupDir");
  const backupCreated = await createOperationalStateBackupInternal({ ...options, backupDir });
  const backupResult = backupCreated.result;
  const backup = await readAndValidateBackup(backupDir, options.signal);
  const paths = resolveOperationalStatePaths(options);
  const inspected = await inspectOperationalStateInternal(options);
  const installation = await prepareMigrationInstallation(backup, paths, inspected, options);
  let state;
  try {
    state = await installPreparedArtifacts(
      installation,
      options.signal,
      async () => {
        const next = await inspectOperationalState(options);
        if (next.migrationRequired || !next.canMigrate) {
          throw stateError(
            "PRIVACYAI_STATE_MIGRATION_FAILED",
            "PrivacyAI migration validation failed. Existing state was restored and the pre-migration backup was preserved.",
            undefined,
            "storage_write"
          );
        }
        return next;
      },
      component => assertStateFingerprintUnchanged(
        paths,
        component === "vault" ? [component, "identity"] : [component],
        backupCreated.sourceFingerprint
      )
    );
  } finally {
    await cleanupPreparedArtifacts(installation);
  }
  return Object.freeze({
    version: STATE_OPERATIONS_VERSION,
    changed: installation.length > 0,
    migrated: installation.map(item => item.component),
    backup: backupResult,
    state
  });
}

export async function repairOperationalState(options = {}) {
  const inspected = await inspectOperationalStateInternal(options);
  if (inspected.report.components.some(component => BLOCKING_BACKUP_STATUSES.has(component.status))) {
    throw stateError(
      "PRIVACYAI_STATE_REPAIR_BLOCKED",
      "PrivacyAI local state contains a condition that automatic repair cannot safely change. Restore a verified backup or follow the preflight recovery step."
    );
  }
  const repairable = inspected.report.components.filter(component => component.status === "repair_required");
  if (repairable.length === 0) {
    return Object.freeze({
      version: STATE_OPERATIONS_VERSION,
      changed: false,
      repaired: [],
      backup: null,
      state: inspected.report
    });
  }
  const backupDir = requiredPath(options.backupDir, "backupDir");
  const backupCreated = await createOperationalStateBackupInternal({ ...options, backupDir });
  const backup = backupCreated.result;
  const repaired = [];
  throwIfAborted(options.signal);
  await assertStateFingerprintUnchanged(
    inspected.paths,
    backupCreated.sourceComponents,
    backupCreated.sourceFingerprint
  );

  for (const component of repairable) {
    await assertStateFingerprintUnchanged(
      inspected.paths,
      [component.name],
      backupCreated.sourceFingerprint
    );
    if (component.name === "configuration") {
      await chmodPrivateFile(inspected.paths.configPath);
    } else if (component.name === "identity") {
      await chmodPrivateFile(inspected.paths.identityKeyPath);
    } else if (component.name === "vault") {
      const latestVault = await inspectVault(
        inspected.paths.vaultDir,
        inspected.runtime.identity.identityRoot
      );
      if (latestVault.component.status !== "repair_required") {
        throw stateError(
          "PRIVACYAI_STATE_BUSY",
          "PrivacyAI session state changed during repair. Stop running agents and retry."
        );
      }
      await chmodPrivateDirectory(inspected.paths.vaultDir);
      for (const file of latestVault.runtime.files) {
        await chmodPrivateFile(join(inspected.paths.vaultDir, file));
      }
      for (const artifact of latestVault.runtime.staleArtifacts) {
        throwIfAborted(options.signal);
        await rm(join(inspected.paths.vaultDir, artifact), { force: true });
      }
    } else if (component.name === "context") {
      await chmodSqliteFiles(inspected.paths.contextDbPath);
    } else if (component.name === "lineage") {
      await chmodSqliteFiles(inspected.paths.lineageDbPath);
    }
    repaired.push(component.name);
  }

  const state = await inspectOperationalState(options);
  return Object.freeze({
    version: STATE_OPERATIONS_VERSION,
    changed: repaired.length > 0,
    repaired,
    backup,
    state
  });
}

async function inspectOperationalStateInternal(options) {
  const paths = resolveOperationalStatePaths(options);
  const [configuration, identity] = await Promise.all([
    inspectConfiguration(paths.configPath),
    inspectIdentity(paths.identityKeyPath)
  ]);
  const [vault, context, lineage] = await Promise.all([
    inspectVault(paths.vaultDir, identity.runtime.identityRoot),
    inspectContext(paths.contextDbPath),
    inspectLineage(paths.lineageDbPath)
  ]);

  if (
    identity.component.status === "uninitialized" &&
    (vault.runtime.recordCount > 0 || context.runtime.exists || lineage.runtime.exists)
  ) {
    identity.component = component("identity", "blocked", {
      currentVersion: null,
      targetVersion: IDENTITY_VERSION,
      nextStep: "Restore the original installation identity from a verified backup before using existing local state."
    });
  }
  if (vault.component.status === "migration_required" && !identity.runtime.identityRoot) {
    vault.component = component("vault", "blocked", {
      currentVersion: 1,
      targetVersion: VAULT_VERSION,
      nextStep: "Restore the installation identity before migrating legacy session vault records."
    });
  }

  const components = [
    configuration.component,
    identity.component,
    vault.component,
    context.component,
    lineage.component
  ];
  const migrationRequired = components.some(value => value.status === "migration_required");
  const repairRequired = components.some(value => value.status === "repair_required");
  const blockers = components.filter(value =>
    BLOCKING_BACKUP_STATUSES.has(value.status) || value.status === "blocked"
  );
  const ready = blockers.length === 0 && !migrationRequired && !repairRequired &&
    configuration.component.status !== "uninitialized";
  const nextSteps = [...new Set(components.map(value => value.nextStep).filter(Boolean))];
  return {
    paths,
    runtime: {
      config: configuration.runtime,
      identity: identity.runtime,
      vault: vault.runtime,
      context: context.runtime,
      lineage: lineage.runtime
    },
    report: Object.freeze({
      version: STATE_OPERATIONS_VERSION,
      ready,
      canBackup: blockers.length === 0,
      canMigrate: blockers.length === 0 && !repairRequired,
      migrationRequired,
      repairRequired,
      components: components.map(value => Object.freeze({ ...value })),
      nextSteps
    })
  };
}

async function inspectConfiguration(path) {
  const inspected = await inspectPrivateJson(path, { maxBytes: 1024 * 1024 });
  if (!inspected.exists) {
    return result(component("configuration", "uninitialized", {
      currentVersion: null,
      targetVersion: CONFIG_VERSION,
      nextStep: "Run `privacyai onboard` to create PrivacyAI configuration."
    }), { exists: false });
  }
  if (inspected.error) return result(componentForFileError("configuration", CONFIG_VERSION, inspected.error), inspected);
  try {
    const parsed = JSON.parse(inspected.text);
    const version = parseOptionalVersion(parsed?.version);
    if (version > CONFIG_VERSION) {
      return result(component("configuration", "unsupported", {
        currentVersion: version,
        targetVersion: CONFIG_VERSION,
        nextStep: "Use a PrivacyAI release that supports this newer configuration or restore an older verified backup."
      }), { ...inspected, version });
    }
    normalizeConfig(parsed);
    const status = version === 0 ? "migration_required" : inspected.permissionRepair ? "repair_required" : "ready";
    return result(component("configuration", status, {
      currentVersion: version,
      targetVersion: CONFIG_VERSION,
      nextStep: status === "migration_required"
        ? "Run `privacyai state migrate --backup <directory>` to version the legacy configuration explicitly."
        : status === "repair_required"
          ? "Run `privacyai state repair --backup <directory>` to restore private file permissions."
          : null
    }), { ...inspected, exists: true, parsed, version });
  } catch {
    return result(component("configuration", "corrupt", {
      currentVersion: null,
      targetVersion: CONFIG_VERSION,
      nextStep: "Restore configuration from a verified backup or run onboarding after preserving the unreadable file for investigation."
    }), { ...inspected, exists: true });
  }
}

async function inspectIdentity(path) {
  const inspected = await inspectPrivateJson(path, { maxBytes: 16 * 1024 });
  if (!inspected.exists) {
    return result(component("identity", "uninitialized", {
      currentVersion: null,
      targetVersion: IDENTITY_VERSION,
      nextStep: null
    }), { exists: false, identityRoot: null });
  }
  if (inspected.error) return result(componentForFileError("identity", IDENTITY_VERSION, inspected.error), { ...inspected, identityRoot: null });
  try {
    const record = JSON.parse(inspected.text);
    const version = Number(record?.version);
    if (Number.isSafeInteger(version) && version > IDENTITY_VERSION) {
      return result(component("identity", "unsupported", {
        currentVersion: version,
        targetVersion: IDENTITY_VERSION,
        nextStep: "Use a PrivacyAI release that supports this installation identity. Do not delete or regenerate the identity file."
      }), { ...inspected, exists: true, identityRoot: null, version });
    }
    if (
      version !== IDENTITY_VERSION ||
      record.algorithm !== "HMAC-SHA-256" ||
      typeof record.key !== "string" ||
      typeof record.keyId !== "string"
    ) throw new TypeError("invalid identity record");
    const key = Buffer.from(record.key, "base64");
    if (key.length !== 32 || key.toString("base64") !== record.key || privacyIdentityKeyId(key) !== record.keyId) {
      throw new TypeError("invalid identity key");
    }
    const identityRoot = createPrivacyIdentityService({ key });
    const status = inspected.permissionRepair ? "repair_required" : "ready";
    return result(component("identity", status, {
      currentVersion: version,
      targetVersion: IDENTITY_VERSION,
      nextStep: status === "repair_required"
        ? "Run `privacyai state repair --backup <directory>` to restore private identity permissions without changing the key."
        : null
    }), { ...inspected, exists: true, identityRoot, keyId: record.keyId, version });
  } catch {
    return result(component("identity", "corrupt", {
      currentVersion: null,
      targetVersion: IDENTITY_VERSION,
      nextStep: "Restore the original installation identity from a verified backup. Never delete it to force a new identity."
    }), { ...inspected, exists: true, identityRoot: null });
  }
}

async function inspectVault(path, identityRoot = null) {
  const directory = await inspectDirectory(path, { privateDirectory: true });
  if (!directory.exists) {
    return result(component("vault", "uninitialized", {
      currentVersion: null,
      targetVersion: VAULT_VERSION,
      nextStep: null
    }), { exists: false, files: [], staleArtifacts: [], recordCount: 0 });
  }
  if (directory.error) return result(componentForFileError("vault", VAULT_VERSION, directory.error), {
    exists: true,
    files: [],
    staleArtifacts: [],
    recordCount: 0
  });

  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  const staleArtifacts = [];
  let recordCount = 0;
  let locatorCount = 0;
  let legacyCount = 0;
  let permissionRepair = directory.permissionRepair;
  let liveArtifacts = 0;
  const locatorTargets = new Map();
  const recordsByFile = new Map();
  const recordFilesBySession = new Map();
  try {
    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      if (entry.isSymbolicLink()) throw unsafePathError();
      if (entry.name.endsWith(".lock")) {
        const state = await inspectVaultLock(fullPath);
        if (state === "live") liveArtifacts += 1;
        else if (state === "stale") staleArtifacts.push(entry.name);
        else throw inspectionError(state);
        continue;
      }
      if (entry.name.endsWith(".tmp")) {
        const info = await lstat(fullPath);
        assertOwnedRegularFile(info);
        if (Date.now() - info.mtimeMs < STALE_TEMP_AGE_MS) liveArtifacts += 1;
        else staleArtifacts.push(entry.name);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) throw unsafePathError();
      const inspected = await inspectPrivateJson(fullPath, { maxBytes: MAX_JSON_BYTES });
      if (inspected.error) throw inspected.error;
      permissionRepair ||= inspected.permissionRepair;
      const value = JSON.parse(inspected.text);
      files.push(entry.name);
      if (value?.kind === VAULT_LOCATOR_KIND) {
        validateVaultLocator(value, entry.name, entries);
        locatorTargets.set(entry.name, value.file);
        locatorCount += 1;
        continue;
      }
      const version = value?.version == null ? 1 : Number(value.version);
      if (version > VAULT_VERSION) {
        return result(component("vault", "unsupported", {
          currentVersion: version,
          targetVersion: VAULT_VERSION,
          nextStep: "Use a PrivacyAI release that supports this newer session vault or restore a compatible verified backup."
        }), { exists: true, files, staleArtifacts, recordCount });
      }
      if (version !== 1 && version !== VAULT_VERSION) throw new TypeError("invalid vault version");
      if (typeof value.sessionId !== "string" || !value.sessionId) throw new TypeError("invalid vault session");
      normalizeSessionMap(value.sessionMap);
      if (version === 1) {
        const expected = createHash("sha256").update(value.sessionId).digest("hex") + ".json";
        if (entry.name !== expected) throw new TypeError("legacy vault filename mismatch");
        legacyCount += 1;
      } else if (!/^v2-[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new TypeError("invalid v2 vault filename");
      }
      if (recordFilesBySession.has(value.sessionId)) {
        throw new TypeError("duplicate vault session record");
      }
      recordFilesBySession.set(value.sessionId, entry.name);
      recordsByFile.set(entry.name, { version, sessionId: value.sessionId });
      recordCount += 1;
    }
    const vault = identityRoot ? new SessionVault({ baseDir: path, identityRoot }) : null;
    const locatedTargets = new Set(locatorTargets.values());
    for (const [legacyFile, targetFile] of locatorTargets) {
      const target = recordsByFile.get(targetFile);
      if (!target || target.version !== VAULT_VERSION) {
        throw new TypeError("vault locator target is not a v2 record");
      }
      const expectedLegacy = createHash("sha256").update(target.sessionId).digest("hex") + ".json";
      if (legacyFile !== expectedLegacy) throw new TypeError("vault locator session mismatch");
    }
    if (vault) {
      for (const [file, record] of recordsByFile) {
        if (record.version !== VAULT_VERSION) continue;
        const currentFile = basename(vault.pathForSession(record.sessionId));
        if (file !== currentFile && !locatedTargets.has(file)) {
          throw new TypeError("orphaned v2 vault record");
        }
      }
    }
  } catch (error) {
    const fileError = normalizeInspectionError(error);
    return result(componentForFileError("vault", VAULT_VERSION, fileError), {
      exists: true,
      files,
      staleArtifacts,
      recordCount
    });
  }

  if (liveArtifacts > 0) {
    return result(component("vault", "busy", {
      currentVersion: legacyCount > 0 ? 1 : VAULT_VERSION,
      targetVersion: VAULT_VERSION,
      recordCount,
      nextStep: "Stop running PrivacyAI agents and retry after active vault operations finish."
    }), { exists: true, files, staleArtifacts, recordCount, locatorCount, legacyCount });
  }
  const status = permissionRepair || staleArtifacts.length > 0
    ? "repair_required"
    : legacyCount > 0
      ? "migration_required"
      : "ready";
  return result(component("vault", status, {
    currentVersion: legacyCount > 0 ? 1 : VAULT_VERSION,
    targetVersion: VAULT_VERSION,
    recordCount,
    nextStep: status === "migration_required"
      ? "Run `privacyai state migrate --backup <directory>` to bind legacy vault records to the existing installation identity."
      : status === "repair_required"
        ? "Run `privacyai state repair --backup <directory>` to remove interrupted artifacts and restore private permissions."
        : null
  }), { exists: true, files, staleArtifacts, recordCount, locatorCount, legacyCount });
}

async function inspectContext(path) {
  return inspectSqliteState(path, "context", CONTEXT_SCHEMA_VERSION, database => {
    const version = readSchemaVersion(database, "privacyai_meta");
    if (version > CONTEXT_SCHEMA_VERSION) return { status: "unsupported", version };
    if (version < 1) return { status: "corrupt", version };
    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => String(row.name)));
    for (const required of ["privacyai_meta", "threads", "verified_items", "thread_items"]) {
      if (!tables.has(required)) return { status: "corrupt", version };
    }
    if (version === CONTEXT_SCHEMA_VERSION && CONTEXT_TABLES.some(table => !tables.has(table))) {
      return { status: "corrupt", version };
    }
    if (version === CONTEXT_SCHEMA_VERSION) {
      const threadColumns = new Set(database.prepare("PRAGMA table_info(threads)").all().map(row => row.name));
      const verifiedColumns = new Set(database.prepare("PRAGMA table_info(verified_items)").all().map(row => row.name));
      if (["identity_key_id", "identity_scope_json", "identity_map_json"].some(name => !threadColumns.has(name)) ||
          ["identity_key_id", "identity_json"].some(name => !verifiedColumns.has(name))) {
        return { status: "corrupt", version };
      }
    }
    return {
      status: version < CONTEXT_SCHEMA_VERSION ? "migration_required" : "ready",
      version
    };
  });
}

async function inspectLineage(path) {
  return inspectSqliteState(path, "lineage", LINEAGE_SCHEMA_VERSION, database => {
    let version;
    try {
      version = readSchemaVersion(database, "privacyai_lineage_meta");
      validateLineageSchemaVersion(database);
      validateLineageSchema(database);
      return { status: "ready", version };
    } catch (error) {
      if (error?.code === "PRIVACYAI_LINEAGE_SCHEMA_UNSUPPORTED") {
        return { status: "unsupported", version };
      }
      if (error?.code === "PRIVACYAI_LINEAGE_SCHEMA_MIGRATION_REQUIRED") {
        return { status: "blocked", version };
      }
      return { status: "corrupt", version };
    }
  });
}

async function inspectSqliteState(path, name, targetVersion, validate) {
  const file = await inspectPrivateFile(path);
  if (!file.exists) {
    return result(component(name, "uninitialized", {
      currentVersion: null,
      targetVersion,
      nextStep: null
    }), { exists: false });
  }
  if (file.error) return result(componentForFileError(name, targetVersion, file.error), file);
  let database;
  try {
    const sidecars = await inspectSqliteSidecars(path);
    const sqlite = await import("node:sqlite");
    const source = sidecars.present
      ? path
      : `${pathToFileURL(path).href}?immutable=1`;
    database = new sqlite.DatabaseSync(source, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    const quickCheck = database.prepare("PRAGMA quick_check(1)").get();
    if (String(quickCheck?.quick_check || "") !== "ok") {
      return result(component(name, "corrupt", {
        currentVersion: null,
        targetVersion,
        nextStep: restoreNextStep(name)
      }), { ...file, exists: true, sidecars });
    }
    const validated = validate(database);
    const status = validated.status === "ready" && (file.permissionRepair || sidecars.permissionRepair)
      ? "repair_required"
      : validated.status;
    return result(component(name, status, {
      currentVersion: validated.version ?? null,
      targetVersion,
      nextStep: sqliteNextStep(name, status)
    }), {
      ...file,
      exists: true,
      version: validated.version,
      sidecars
    });
  } catch (error) {
    const normalized = normalizeInspectionError(error);
    return result(componentForFileError(name, targetVersion, normalized), { ...file, exists: true });
  } finally {
    try { database?.close(); } catch {}
  }
}

function component(name, status, values = {}) {
  return {
    name,
    status,
    currentVersion: values.currentVersion ?? null,
    targetVersion: values.targetVersion ?? null,
    ...(values.recordCount == null ? {} : { recordCount: values.recordCount }),
    nextStep: values.nextStep || null
  };
}

function result(componentValue, runtime) {
  return { component: componentValue, runtime };
}

function componentForFileError(name, targetVersion, error) {
  const status = error?.kind || "unavailable";
  return component(name, status, {
    currentVersion: null,
    targetVersion,
    nextStep: status === "repair_required"
      ? "Run `privacyai state repair --backup <directory>` to restore private permissions."
      : status === "unsafe"
        ? "Move the state to an owned, non-symlinked path with regular single-link files before retrying."
        : restoreNextStep(name)
  });
}

function sqliteNextStep(name, status) {
  if (status === "migration_required") {
    return `Run \`privacyai state migrate --backup <directory>\` to upgrade the ${name} database explicitly.`;
  }
  if (status === "repair_required") {
    return "Run `privacyai state repair --backup <directory>` to restore private SQLite permissions.";
  }
  if (status === "unsupported") {
    return `Use a PrivacyAI release that supports the newer ${name} schema or restore a compatible verified backup.`;
  }
  if (status === "blocked") {
    return `This release has no safe migration for the older ${name} schema; use a compatible release or restore a verified backup.`;
  }
  if (status === "corrupt") return restoreNextStep(name);
  return null;
}

function restoreNextStep(name) {
  return `Restore the ${name} state from a verified backup before running PrivacyAI.`;
}

async function inspectPrivateJson(path, options = {}) {
  const inspected = await inspectPrivateFile(path);
  if (!inspected.exists || inspected.error) return inspected;
  if (inspected.size > (options.maxBytes || MAX_JSON_BYTES)) {
    return { ...inspected, error: inspectionError("corrupt") };
  }
  try {
    return { ...inspected, text: await readStablePrivateFile(path, options.maxBytes || MAX_JSON_BYTES) };
  } catch (error) {
    return { ...inspected, error: normalizeInspectionError(error) };
  }
}

async function inspectPrivateFile(path) {
  try {
    await assertNoSymlinkComponents(path);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      return { exists: true, error: inspectionError("unsafe") };
    }
    if (!ownedByCurrentUser(info)) return { exists: true, error: inspectionError("unsafe") };
    return {
      exists: true,
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
      permissionRepair: (info.mode & 0o077) !== 0
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    return { exists: true, error: normalizeInspectionError(error) };
  }
}

async function inspectDirectory(path, options = {}) {
  try {
    await assertNoSymlinkComponents(path);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || !ownedByCurrentUser(info)) {
      return { exists: true, error: inspectionError("unsafe") };
    }
    return {
      exists: true,
      permissionRepair: options.privateDirectory && (info.mode & 0o077) !== 0
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    return { exists: true, error: normalizeInspectionError(error) };
  }
}

async function inspectSqliteSidecars(path) {
  const results = await Promise.all(["-wal", "-shm"].map(async suffix => {
    const inspected = await inspectPrivateFile(path + suffix);
    return { suffix, ...inspected };
  }));
  const present = results.filter(value => value.exists);
  if (present.length === 1) throw inspectionError("busy");
  for (const item of present) if (item.error) throw item.error;
  return {
    present: present.length === 2,
    permissionRepair: present.some(value => value.permissionRepair)
  };
}

async function inspectVaultLock(path) {
  const inspected = await inspectPrivateJson(path, { maxBytes: 16 * 1024 });
  if (inspected.error) {
    if (inspected.error.kind === "unsafe" || inspected.error.kind === "unavailable") {
      return inspected.error.kind;
    }
    return isRecentArtifact(inspected.mtimeMs, STALE_LOCK_AGE_MS) ? "live" : "stale";
  }
  try {
    const record = JSON.parse(inspected.text);
    return await isSameLiveProcess(record) ? "live" : "stale";
  } catch {
    return isRecentArtifact(inspected.mtimeMs, STALE_LOCK_AGE_MS) ? "live" : "stale";
  }
}

function isRecentArtifact(mtimeMs, maximumAgeMs) {
  return Number.isFinite(mtimeMs) && Date.now() - mtimeMs <= maximumAgeMs;
}

function validateVaultLocator(value, name, entries) {
  if (
    value.version !== VAULT_LOCATOR_VERSION ||
    value.kind !== VAULT_LOCATOR_KIND ||
    typeof value.file !== "string" ||
    basename(value.file) !== value.file ||
    !/^v2-[a-f0-9]{64}\.json$/.test(value.file) ||
    !/^[a-f0-9]{64}\.json$/.test(name) ||
    !entries.some(entry => entry.isFile() && entry.name === value.file)
  ) {
    throw new TypeError("invalid vault locator");
  }
}

function parseOptionalVersion(value) {
  if (value == null) return 0;
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new TypeError("invalid version");
  return version;
}

function readSchemaVersion(database, table) {
  const tables = new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map(row => String(row.name)));
  if (!tables.has(table)) throw new TypeError("missing schema metadata");
  const row = database.prepare(`SELECT value FROM ${table} WHERE key = 'schema_version'`).get();
  const version = Number(row?.value);
  if (!Number.isSafeInteger(version) || version < 0) throw new TypeError("invalid schema version");
  return version;
}

function inspectionError(kind) {
  const error = new Error("PrivacyAI state inspection failed.");
  error.kind = kind;
  return error;
}

function unsafePathError() {
  return inspectionError("unsafe");
}

function normalizeInspectionError(error) {
  if (error?.kind) return error;
  if (error?.code === "EACCES" || error?.code === "EPERM") return inspectionError("unavailable");
  if (error?.code === "ELOOP" || error?.code === "ENOTDIR") return inspectionError("unsafe");
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("database is locked") || message.includes("database is busy")) {
    return inspectionError("busy");
  }
  return inspectionError("corrupt");
}

function assertBackupSupported(report) {
  const blocker = report.components.find(component => BLOCKING_BACKUP_STATUSES.has(component.status));
  if (blocker) {
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_BLOCKED",
      "PrivacyAI cannot back up local state safely until the preflight blocker is resolved."
    );
  }
}

async function backupPrivateFile(source, destination, manifestFile, signal) {
  throwIfAborted(signal);
  const bytes = await readStablePrivateFile(source, Number.MAX_SAFE_INTEGER);
  await writePrivateBytes(destination, bytes);
  return fileManifestEntry(manifestFile, bytes);
}

async function backupVault(sourceDir, destinationDir, fileNames, signal) {
  await mkdir(destinationDir, { mode: 0o700 });
  const before = await vaultSnapshotFingerprint(sourceDir, fileNames);
  const files = [];
  for (const name of [...fileNames].sort()) {
    throwIfAborted(signal);
    const bytes = await readStablePrivateFile(join(sourceDir, name), MAX_JSON_BYTES);
    const destination = join(destinationDir, name);
    await writePrivateBytes(destination, bytes);
    files.push({ file: name, ...fileDigest(bytes) });
  }
  const afterEntries = await readdir(sourceDir, { withFileTypes: true });
  const afterNames = afterEntries.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => entry.name).sort();
  if (JSON.stringify(afterNames) !== JSON.stringify([...fileNames].sort()) ||
      before !== await vaultSnapshotFingerprint(sourceDir, fileNames)) {
    throw stateError(
      "PRIVACYAI_STATE_BUSY",
      "PrivacyAI session state changed during backup. Stop running agents and retry."
    );
  }
  return { directory: "vault", files };
}

async function vaultSnapshotFingerprint(path, fileNames) {
  const records = [];
  for (const name of [...fileNames].sort()) {
    const info = await lstat(join(path, name));
    assertOwnedRegularFile(info);
    records.push([name, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
  }
  return JSON.stringify(records);
}

async function backupSqlite(source, destination, signal) {
  throwIfAborted(signal);
  let database;
  try {
    const before = await lstat(source);
    assertOwnedRegularFile(before);
    const sqlite = await import("node:sqlite");
    const hasWal = await pathExists(source + "-wal");
    const databaseSource = hasWal ? source : `${pathToFileURL(source).href}?immutable=1`;
    database = new sqlite.DatabaseSync(databaseSource, { readOnly: true });
    const afterOpen = await lstat(source);
    if (before.dev !== afterOpen.dev || before.ino !== afterOpen.ino) throw unsafePathError();
    await sqlite.backup(database, destination, {
      rate: 32,
      progress: () => throwIfAborted(signal)
    });
    await chmodPrivateFile(destination);
    const bytes = await readStablePrivateFile(destination, Number.MAX_SAFE_INTEGER);
    return { file: basename(destination), ...fileDigest(bytes) };
  } catch (error) {
    if (error?.name === "AbortError" || isStateError(error)) throw error;
    if (isSqliteBusyError(error)) {
      throw stateError(
        "PRIVACYAI_STATE_BUSY",
        "PrivacyAI could not capture a consistent SQLite backup. Stop running agents and retry.",
        error
      );
    }
    if (error?.kind === "unsafe") {
      throw stateError(
        "PRIVACYAI_STATE_BACKUP_BLOCKED",
        "PrivacyAI SQLite state changed to an unsafe path during backup. Stop using the state path and run preflight again.",
        error
      );
    }
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_FAILED",
      "PrivacyAI could not create a complete SQLite backup.",
      error,
      "storage_write"
    );
  } finally {
    try { database?.close(); } catch {}
  }
}

function isSqliteBusyError(error) {
  if (error?.kind === "busy") return true;
  const code = String(error?.code || "").toUpperCase();
  if (code.includes("SQLITE_BUSY") || code.includes("SQLITE_LOCKED")) return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("database is busy") || message.includes("database is locked");
}

function fileManifestEntry(file, bytes) {
  return { file, ...fileDigest(bytes) };
}

function fileDigest(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length
  };
}

async function readAndValidateBackup(backupDir, signal) {
  throwIfAborted(signal);
  const directory = await inspectDirectory(backupDir, { privateDirectory: true });
  if (!directory.exists || directory.error || directory.permissionRepair) {
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_INVALID",
      "PrivacyAI backup is missing, unsafe, or does not have private permissions."
    );
  }
  let manifest;
  try {
    const serialized = await readStablePrivateFile(join(backupDir, "manifest.json"), 1024 * 1024);
    manifest = JSON.parse(serialized.toString("utf8"));
  } catch (error) {
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_INVALID",
      "PrivacyAI backup manifest is invalid.",
      error
    );
  }
  if (
    !manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
    manifest.kind !== BACKUP_KIND || manifest.version !== STATE_BACKUP_VERSION ||
    !manifest.components || typeof manifest.components !== "object" || Array.isArray(manifest.components)
  ) {
    throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI backup manifest is invalid.");
  }
  const allowed = new Set(["configuration", "identity", "vault", "context", "lineage"]);
  if (Object.keys(manifest.components).some(name => !allowed.has(name))) {
    throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI backup contains an unsupported component.");
  }
  for (const [name, entry] of Object.entries(manifest.components)) {
    throwIfAborted(signal);
    if (name === "vault") {
      if (entry?.directory !== "vault" || !Array.isArray(entry.files)) {
        throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI vault backup manifest is invalid.");
      }
      const files = entry.files.map(file => file?.file);
      for (const file of entry.files) {
        assertBackupRelativeFile(file?.file);
        if (basename(file.file) !== file.file || !file.file.endsWith(".json")) {
          throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI vault backup manifest contains an unsafe path.");
        }
        await verifyBackupFile(join(backupDir, "vault", file.file), file);
      }
      if (new Set(files).size !== files.length) {
        throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI vault backup manifest contains duplicate files.");
      }
      const actual = (await readdir(join(backupDir, "vault"), { withFileTypes: true }))
        .map(item => item.isFile() && !item.isSymbolicLink() ? item.name : null);
      if (actual.includes(null) || JSON.stringify(actual.sort()) !== JSON.stringify([...files].sort())) {
        throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI vault backup contents do not match the verified manifest.");
      }
      continue;
    }
    assertBackupRelativeFile(entry?.file);
    await verifyBackupFile(join(backupDir, entry.file), entry);
  }
  await validateBackupComponents(backupDir, manifest, signal);
  return { backupDir, manifest };
}

async function validateBackupComponents(backupDir, manifest, signal) {
  const allowedStatuses = new Set(["ready", "migration_required", "repair_required", "uninitialized"]);
  const inspections = [];
  if (manifest.components.configuration) {
    inspections.push(await inspectConfiguration(join(backupDir, manifest.components.configuration.file)));
  }
  let identityInspection = null;
  if (manifest.components.identity) {
    identityInspection = await inspectIdentity(join(backupDir, manifest.components.identity.file));
    inspections.push(identityInspection);
  }
  if (manifest.components.vault) {
    inspections.push(await inspectVault(
      join(backupDir, "vault"),
      identityInspection?.runtime.identityRoot || null
    ));
  }
  if (manifest.components.context) {
    inspections.push(await inspectContext(join(backupDir, manifest.components.context.file)));
  }
  if (manifest.components.lineage) {
    inspections.push(await inspectLineage(join(backupDir, manifest.components.lineage.file)));
  }
  if (inspections.some(value => !allowedStatuses.has(value.component.status))) {
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_INVALID",
      "PrivacyAI backup contains state that is corrupt or incompatible with this release."
    );
  }

  if (manifest.components.vault?.files?.length > 0 && !identityInspection?.runtime.identityRoot) {
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_INVALID",
      "PrivacyAI backup contains session state without its installation identity."
    );
  }

  if (manifest.components.vault && identityInspection?.runtime.identityRoot) {
    const vaultDir = join(backupDir, "vault");
    const vault = new SessionVault({ baseDir: vaultDir, identityRoot: identityInspection.runtime.identityRoot });
    for (const entry of await readdir(vaultDir, { withFileTypes: true })) {
      throwIfAborted(signal);
      if (!entry.isFile() || !/^v2-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const value = JSON.parse((await readStablePrivateFile(join(vaultDir, entry.name), MAX_JSON_BYTES)).toString("utf8"));
      if (typeof value.sessionId !== "string" || !value.sessionId) {
        throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI backup contains an invalid session vault record.");
      }
      await vault.load(value.sessionId);
    }
  }
}

async function verifyBackupFile(path, entry) {
  const bytes = await readStablePrivateFile(path, Number.MAX_SAFE_INTEGER);
  if (
    !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(entry?.sha256 || "") ||
    bytes.length !== entry.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== entry.sha256
  ) {
    throw stateError(
      "PRIVACYAI_STATE_BACKUP_INVALID",
      "PrivacyAI backup integrity verification failed."
    );
  }
}

function assertBackupRelativeFile(value) {
  if (
    typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") ||
    resolve("/backup-root", value) === "/backup-root" ||
    !resolve("/backup-root", value).startsWith(`/backup-root${sep}`) ||
    value.split(/[\\/]/).some(part => !part || part === "." || part === "..")
  ) {
    throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI backup manifest contains an unsafe path.");
  }
}

function assertRestoreDestinations(current, backup, options) {
  const components = backup.manifest.components;
  const byName = new Map(current.report.components.map(value => [value.name, value]));
  for (const name of Object.keys(components)) {
    const status = byName.get(name)?.status;
    if (["unsafe", "busy", "unavailable"].includes(status)) {
      throw stateError(
        "PRIVACYAI_STATE_RESTORE_BLOCKED",
        "PrivacyAI cannot restore over an unsafe or active local-state path."
      );
    }
    if (name !== "identity" && status !== "uninitialized" && options.replace !== true) {
      throw stateError(
        "PRIVACYAI_STATE_RESTORE_REPLACE_REQUIRED",
        "PrivacyAI restore would replace existing state. Re-run with explicit replacement enabled after reviewing the backup."
      );
    }
  }
}

async function prepareRestoreInstallation(backup, paths, options) {
  const plans = [];
  const components = backup.manifest.components;
  const targetByName = {
    configuration: paths.configPath,
    identity: paths.identityKeyPath,
    vault: paths.vaultDir,
    context: paths.contextDbPath,
    lineage: paths.lineageDbPath
  };
  try {
    for (const [name, entry] of Object.entries(components)) {
      throwIfAborted(options.signal);
      const target = targetByName[name];
      if (name === "identity") {
        const source = join(backup.backupDir, entry.file);
        const sourceIdentity = await identityKeyIdFromFile(source);
        const currentIdentity = await optionalIdentityState(target);
        const identityChanged = currentIdentity.exists && currentIdentity.keyId !== sourceIdentity;
        if (identityChanged && options.replaceIdentity !== true) {
          throw stateError(
            "PRIVACYAI_STATE_IDENTITY_REPLACE_REQUIRED",
            "The backup would replace the installation identity. Re-run only with explicit identity replacement after confirming this rollback is intended."
          );
        }
        plans.push(await stageFilePlan(name, source, target, { identityChanged }));
        continue;
      }
      if (name === "vault") {
        plans.push(await stageDirectoryPlan(
          name,
          join(backup.backupDir, "vault"),
          target,
          entry.files.map(file => file.file)
        ));
      } else {
        plans.push(await stageFilePlan(name, join(backup.backupDir, entry.file), target));
      }
    }
    return plans;
  } catch (error) {
    await cleanupPreparedArtifacts(plans);
    throw error;
  }
}

async function prepareMigrationInstallation(backup, paths, inspected, options) {
  const plans = [];
  const byName = new Map(inspected.report.components.map(value => [value.name, value]));
  try {
    if (byName.get("configuration")?.status === "migration_required") {
      const source = join(backup.backupDir, backup.manifest.components.configuration.file);
      const parsed = JSON.parse((await readStablePrivateFile(source, 1024 * 1024)).toString("utf8"));
      const normalized = normalizeConfig(parsed);
      const plan = await emptyFilePlan("configuration", paths.configPath);
      plans.push(plan);
      await writePrivateJson(plan.stage, normalized);
    }
    if (byName.get("context")?.status === "migration_required") {
      const source = join(backup.backupDir, backup.manifest.components.context.file);
      const plan = await stageFilePlan("context", source, paths.contextDbPath);
      plans.push(plan);
      await migrateContextDatabase(plan.stage);
    }
    if (byName.get("vault")?.status === "migration_required") {
      const identityEntry = backup.manifest.components.identity;
      if (!identityEntry) {
        throw stateError(
          "PRIVACYAI_STATE_MIGRATION_BLOCKED",
          "PrivacyAI cannot migrate legacy vault records without the original installation identity."
        );
      }
      const identityRoot = await identityRootFromFile(join(backup.backupDir, identityEntry.file));
      const plan = await stageDirectoryPlan(
        "vault",
        join(backup.backupDir, "vault"),
        paths.vaultDir,
        backup.manifest.components.vault.files.map(file => file.file)
      );
      plans.push(plan);
      await migrateVaultDirectory(plan.stage, identityRoot, options.signal);
    }
    return plans;
  } catch (error) {
    await cleanupPreparedArtifacts(plans);
    throw error;
  }
}

async function migrateContextDatabase(path) {
  let database;
  try {
    const sqlite = await import("node:sqlite");
    database = new sqlite.DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    initializeSchema(database, { allowMigration: true });
    const quick = database.prepare("PRAGMA quick_check(1)").get();
    if (String(quick?.quick_check || "") !== "ok") throw new TypeError("context migration check failed");
  } catch (error) {
    throw stateError(
      "PRIVACYAI_STATE_MIGRATION_FAILED",
      "PrivacyAI could not migrate the context database. The live database was not replaced.",
      error,
      "storage_write"
    );
  } finally {
    try { database?.close(); } catch {}
  }
  await chmodPrivateFile(path);
}

async function migrateVaultDirectory(path, identityRoot, signal) {
  const entries = await readdir(path, { withFileTypes: true });
  const vault = new SessionVault({ baseDir: path, identityRoot });
  for (const entry of entries) {
    throwIfAborted(signal);
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const source = join(path, entry.name);
    const value = JSON.parse((await readStablePrivateFile(source, MAX_JSON_BYTES)).toString("utf8"));
    if (value?.kind === VAULT_LOCATOR_KIND) continue;
    const version = value?.version == null ? 1 : Number(value.version);
    if (version !== 1) continue;
    const sessionId = String(value.sessionId || "");
    const expected = createHash("sha256").update(sessionId).digest("hex") + ".json";
    if (!sessionId || expected !== entry.name) {
      throw stateError(
        "PRIVACYAI_STATE_MIGRATION_FAILED",
        "PrivacyAI found an invalid legacy vault record. The live vault was not replaced."
      );
    }
    await vault.save(sessionId, normalizeSessionMap(value.sessionMap));
  }
}

async function stageFilePlan(componentName, source, target, extra = {}) {
  const plan = await emptyFilePlan(componentName, target, extra);
  try {
    const bytes = await readStablePrivateFile(source, Number.MAX_SAFE_INTEGER);
    await writePrivateBytes(plan.stage, bytes);
    return plan;
  } catch (error) {
    await rm(plan.stage, { force: true }).catch(() => {});
    throw error;
  }
}

async function emptyFilePlan(componentName, target, extra = {}) {
  await ensureDestinationParent(target);
  return {
    component: componentName,
    type: "file",
    target,
    stage: `${target}.${process.pid}.${randomUUID()}.restore-tmp`,
    rollback: `${target}.${process.pid}.${randomUUID()}.restore-old`,
    ...extra
  };
}

async function stageDirectoryPlan(componentName, source, target, fileNames) {
  await ensureDestinationParent(target);
  const stage = `${target}.${process.pid}.${randomUUID()}.restore-tmp`;
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const name of fileNames) {
      const bytes = await readStablePrivateFile(join(source, name), MAX_JSON_BYTES);
      await writePrivateBytes(join(stage, name), bytes);
    }
    return {
      component: componentName,
      type: "directory",
      target,
      stage,
      rollback: `${target}.${process.pid}.${randomUUID()}.restore-old`
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function installPreparedArtifacts(plans, signal, validate, beforeInstall) {
  const movedOld = [];
  const installed = [];
  try {
    for (const plan of plans) {
      throwIfAborted(signal);
      await beforeInstall?.(plan.component);
      if (plan.component === "context" || plan.component === "lineage") {
        await assertSqliteQuiescent(plan.target);
      }
      if (await pathExists(plan.target)) {
        await assertSafeRestoreTarget(plan.target, plan.type);
        await rename(plan.target, plan.rollback);
        movedOld.push(plan);
      }
      throwIfAborted(signal);
      await rename(plan.stage, plan.target);
      installed.push(plan);
      if (plan.type === "file") await chmodPrivateFile(plan.target);
      else await chmodPrivateDirectory(plan.target);
    }
    const validated = await validate();
    for (const plan of movedOld) {
      await rm(plan.rollback, { recursive: plan.type === "directory", force: true }).catch(() => {});
    }
    return validated;
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of installed.reverse()) {
      try {
        await rm(plan.target, { recursive: plan.type === "directory", force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const plan of movedOld.reverse()) {
      try {
        if (await pathExists(plan.rollback)) await rename(plan.rollback, plan.target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw stateError(
        "PRIVACYAI_STATE_ROLLBACK_FAILED",
        "PrivacyAI could not fully restore prior local state after an interrupted operation. Keep the verified backup and stop using PrivacyAI until recovery is completed.",
        error,
        "storage_write"
      );
    }
    if (error?.name === "AbortError" || isStateError(error)) throw error;
    throw stateError(
      "PRIVACYAI_STATE_INSTALL_FAILED",
      "PrivacyAI could not install restored state. Existing state was preserved.",
      error,
      "storage_write"
    );
  }
}

async function assertSqliteQuiescent(path) {
  if (!await pathExists(path)) return;
  let database;
  try {
    const sqlite = await import("node:sqlite");
    database = new sqlite.DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 1");
    database.exec("BEGIN IMMEDIATE");
    database.exec("ROLLBACK");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(checkpoint?.busy || 0) !== 0) throw inspectionError("busy");
  } catch (error) {
    try { database?.exec("ROLLBACK"); } catch {}
    if (isStateError(error)) throw error;
    throw stateError(
      "PRIVACYAI_STATE_BUSY",
      "PrivacyAI SQLite state is active. Stop running agents and retry the operation.",
      error
    );
  } finally {
    try { database?.close(); } catch {}
  }
  for (const sidecar of [path + "-wal", path + "-shm"]) {
    try {
      const info = await lstat(sidecar);
      assertOwnedRegularFile(info);
      await rm(sidecar);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw stateError(
          "PRIVACYAI_STATE_BUSY",
          "PrivacyAI SQLite state is active. Stop running agents and retry the operation.",
          error
        );
      }
    }
  }
}

async function cleanupPreparedArtifacts(plans) {
  for (const plan of plans) {
    await rm(plan.stage, { recursive: plan.type === "directory", force: true }).catch(() => {});
  }
}

async function identityRootFromFile(path) {
  const bytes = await readStablePrivateFile(path, 16 * 1024);
  const record = JSON.parse(bytes.toString("utf8"));
  const key = Buffer.from(record.key, "base64");
  if (
    record.version !== IDENTITY_VERSION ||
    record.algorithm !== "HMAC-SHA-256" ||
    key.length !== 32 ||
    key.toString("base64") !== record.key ||
    privacyIdentityKeyId(key) !== record.keyId
  ) {
    throw stateError("PRIVACYAI_STATE_BACKUP_INVALID", "PrivacyAI backup installation identity is invalid.");
  }
  return createPrivacyIdentityService({ key });
}

async function identityKeyIdFromFile(path) {
  return (await identityRootFromFile(path)).keyId;
}

async function optionalIdentityState(path) {
  try {
    return { exists: true, keyId: await identityKeyIdFromFile(path) };
  } catch {
    try {
      await lstat(path);
    } catch (statError) {
      if (statError?.code === "ENOENT") return { exists: false, keyId: null };
      throw statError;
    }
    return { exists: true, keyId: null };
  }
}

function presentComponentNames(runtime) {
  return [
    runtime.config?.exists ? "configuration" : null,
    runtime.identity?.exists ? "identity" : null,
    runtime.vault?.exists ? "vault" : null,
    runtime.context?.exists ? "context" : null,
    runtime.lineage?.exists ? "lineage" : null
  ].filter(Boolean);
}

async function assertStateFingerprintUnchanged(paths, components, expected) {
  for (const name of [...new Set(components)]) {
    const current = await captureComponentFingerprint(paths, name);
    if (current !== expected[name]) {
      throw stateError(
        "PRIVACYAI_STATE_BUSY",
        "PrivacyAI local state changed during the operation. Stop running agents and retry."
      );
    }
  }
}

async function captureStateFingerprint(paths, components) {
  const values = {};
  for (const name of [...new Set(components)].sort()) {
    values[name] = await captureComponentFingerprint(paths, name);
  }
  return Object.freeze(values);
}

async function captureComponentFingerprint(paths, name) {
  try {
    let value;
    if (name === "configuration") value = await captureFileFingerprint(paths.configPath);
    else if (name === "identity") value = await captureFileFingerprint(paths.identityKeyPath);
    else if (name === "vault") value = await captureDirectoryFingerprint(paths.vaultDir);
    else if (name === "context") value = await captureSqliteFingerprint(paths.contextDbPath);
    else if (name === "lineage") value = await captureSqliteFingerprint(paths.lineageDbPath);
    else throw new TypeError("unknown state component");
    return JSON.stringify(value);
  } catch (error) {
    if (isStateError(error)) throw error;
    throw stateError(
      "PRIVACYAI_STATE_BUSY",
      "PrivacyAI local state changed during the operation. Stop running agents and retry.",
      error
    );
  }
}

async function captureSqliteFingerprint(path) {
  return Promise.all([
    captureFileFingerprint(path),
    captureFileFingerprint(path + "-wal")
  ]);
}

async function captureDirectoryFingerprint(path) {
  const directory = await capturePathFingerprint(path, "directory");
  if (directory[0] === "missing") return [directory, []];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw unsafePathError();
    files.push([entry.name, await captureFileFingerprint(join(path, entry.name))]);
  }
  return [directory, files];
}

async function captureFileFingerprint(path) {
  return capturePathFingerprint(path, "file");
}

async function capturePathFingerprint(path, expectedType) {
  await assertNoSymlinkComponents(path);
  let info;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return ["missing"];
    throw error;
  }
  const validType = expectedType === "file"
    ? info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
    : info.isDirectory() && !info.isSymbolicLink();
  if (!validType || (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid()))) {
    throw unsafePathError();
  }
  return [
    expectedType,
    String(info.dev),
    String(info.ino),
    String(info.size),
    String(info.mode & 0o777n),
    String(info.mtimeNs),
    String(info.ctimeNs)
  ];
}

async function readStablePrivateFile(path, maximumBytes) {
  let handle;
  try {
    await assertNoSymlinkComponents(path);
    const before = await lstat(path);
    assertOwnedRegularFile(before);
    if ((before.mode & 0o077) !== 0) {
      // Read-only inspection and backup may preserve a repairable file, but never
      // follow links, read hardlinks, or expose its contents in diagnostics.
    }
    if (Number(before.size) > maximumBytes) throw inspectionError("corrupt");
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    assertOwnedRegularFile(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw unsafePathError();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      opened.dev !== after.dev || opened.ino !== after.ino ||
      opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
    ) throw inspectionError("busy");
    if (bytes.length > maximumBytes) throw inspectionError("corrupt");
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertOwnedRegularFile(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownedByCurrentUser(info)) {
    throw unsafePathError();
  }
}

function ownedByCurrentUser(info) {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

async function assertNoSymlinkComponents(path) {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw unsafePathError();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function ensureDirectoryPath(path, options = {}) {
  await assertNoSymlinkComponents(path);
  let created = false;
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code !== "ENOENT" || !options.create) throw error;
    await mkdir(path, { recursive: true, mode: options.privateDirectory ? 0o700 : 0o755 });
    created = true;
  }
  await assertNoSymlinkComponents(path);
  const info = await lstat(path);
  if (!info.isDirectory() || !ownedByCurrentUser(info) || (info.mode & 0o022) !== 0) {
    throw unsafePathError();
  }
  if (created && options.privateDirectory) await chmodPrivateDirectory(path);
}

async function ensureDestinationParent(path) {
  const parent = dirname(path);
  await ensureDirectoryPath(parent, { create: true, privateDirectory: true });
}

async function chmodPrivateFile(path) {
  let handle;
  try {
    await assertNoSymlinkComponents(path);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    assertOwnedRegularFile(info);
    await handle.chmod(0o600);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function chmodPrivateDirectory(path) {
  let handle;
  try {
    await assertNoSymlinkComponents(path);
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)
    );
    const info = await handle.stat();
    if (!info.isDirectory() || !ownedByCurrentUser(info)) throw unsafePathError();
    await handle.chmod(0o700);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function chmodSqliteFiles(path) {
  for (const candidate of [path, path + "-wal", path + "-shm"]) {
    try {
      const info = await lstat(candidate);
      assertOwnedRegularFile(info);
      await chmodPrivateFile(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function assertSafeRestoreTarget(path, type) {
  await assertNoSymlinkComponents(path);
  const info = await lstat(path);
  if (!ownedByCurrentUser(info) || info.isSymbolicLink()) throw unsafePathError();
  if (type === "file" && (!info.isFile() || info.nlink !== 1)) throw unsafePathError();
  if (type === "directory" && !info.isDirectory()) throw unsafePathError();
}

async function writePrivateBytes(path, bytes) {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

async function writePrivateJson(path, value) {
  await writePrivateBytes(path, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
}

async function assertPathMissing(path, message) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw stateError("PRIVACYAI_STATE_DESTINATION_EXISTS", message);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function requiredPath(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw stateError(
      "PRIVACYAI_STATE_INVALID_OPTIONS",
      `PrivacyAI ${name} must be a non-empty filesystem path.`
    );
  }
  return resolve(value);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PrivacyAI state operation was cancelled.");
  error.name = "AbortError";
  throw error;
}

function stateError(code, publicMessage, cause, phase = "storage_read") {
  return createPrivacyError({
    code,
    category: "storage",
    phase,
    message: publicMessage,
    publicMessage,
    ...(cause == null ? {} : { cause })
  });
}

function isStateError(error) {
  return typeof error?.code === "string" && error.code.startsWith("PRIVACYAI_STATE_");
}
