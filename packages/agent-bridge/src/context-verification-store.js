import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCHEMA_VERSION = 2;
const DEFAULT_MAX_VERIFIED_ITEMS = 10000;
const DEFAULT_MAX_THREAD_ITEMS = 50000;
const DEFAULT_MAX_THREADS = 10000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LEDGER_ITEMS = 100000;
const LEDGER_TABLES = [
  // Only prune ownership roots.  Pruning a dependent row by itself can turn a
  // manifest or plan into a silently incomplete record; foreign-key cascades
  // remove its children atomically instead.
  "ledger_repositories", "ledger_content_identities", "ledger_manifests",
  "ledger_privacy_plans", "ledger_file_mutations"
];

export async function openContextVerificationStore(options = {}) {
  if (options.verificationStore) return options.verificationStore;

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      return new MemoryContextVerificationStore(options);
    }
    throw error;
  }

  const path = resolve(
    options.verificationDbPath ||
    process.env.PRIVACYAI_CONTEXT_DB ||
    join(homedir(), ".local", "share", "privacyai", "context-gateway.sqlite3")
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  let database;
  try {
    database = new sqlite.DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA busy_timeout = 10000");
    initializeSchema(database);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original database error.
    }
    if (String(error?.code || "").startsWith("PRIVACYAI_CONTEXT_DB_")) throw error;
    throw contextStoreError(
      "PRIVACYAI_CONTEXT_DB_UNAVAILABLE",
      "PrivacyAI could not open its local context verification database.",
      error
    );
  }

  return new SqliteContextVerificationStore(database, path, options);
}

export function verificationFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

class SqliteContextVerificationStore {
  constructor(database, path, options = {}) {
    this.database = database;
    this.path = path;
    this.persistent = true;
    this.maxVerifiedItems = positiveInteger(
      options.maxVerifiedItems,
      DEFAULT_MAX_VERIFIED_ITEMS,
      "maxVerifiedItems"
    );
    this.maxThreadItems = positiveInteger(
      options.maxThreadItems,
      DEFAULT_MAX_THREAD_ITEMS,
      "maxThreadItems"
    );
    this.maxAgeMs = positiveInteger(options.verificationMaxAgeMs, DEFAULT_MAX_AGE_MS, "verificationMaxAgeMs");
    this.maxThreads = positiveInteger(options.maxThreads, DEFAULT_MAX_THREADS, "maxThreads");
    this.maxLedgerItems = positiveInteger(options.maxLedgerItems, DEFAULT_MAX_LEDGER_ITEMS, "maxLedgerItems");
    this.statements = prepareStatements(database);
    this.closed = false;
  }

  loadThread(sessionKey) {
    this.assertOpen();
    const row = this.statements.loadThread.get(sessionKey);
    if (!row) return emptyThread(sessionKey);
    return {
      sessionKey,
      parentSessionKeys: parseStringArray(row.parent_keys_json, "thread parent keys"),
      sessionMap: parseSessionMap(row.session_map_json, "thread session map"),
      policyFingerprint: String(row.policy_fingerprint || ""),
      updatedAt: Number(row.updated_at || 0)
    };
  }

  saveThread(sessionKey, record = {}) {
    this.assertOpen();
    const now = Date.now();
    this.statements.saveThread.run(
      sessionKey,
      JSON.stringify(normalizeStringArray(record.parentSessionKeys)),
      JSON.stringify(normalizeSessionMap(record.sessionMap)),
      String(record.policyFingerprint || ""),
      now
    );
    return { ...record, sessionKey, updatedAt: now };
  }

  getVerification(cacheKey, policyFingerprint) {
    this.assertOpen();
    const row = this.statements.getVerification.get(cacheKey, policyFingerprint);
    if (!row) return undefined;
    const now = Date.now();
    if (Number(row.last_used_at || 0) < now - this.maxAgeMs) {
      this.statements.deleteVerification.run(cacheKey);
      return undefined;
    }
    const additions = parseSessionMap(row.additions_json, "verified item additions");
    this.statements.touchVerification.run(now, cacheKey);
    return {
      cacheKey,
      contentHash: String(row.content_hash),
      artifactType: String(row.artifact_type),
      policyFingerprint: String(row.policy_fingerprint),
      sessionMapAdditions: additions
    };
  }

  putVerification(record) {
    this.assertOpen();
    const now = Date.now();
    this.statements.putVerification.run(
      record.cacheKey,
      record.contentHash,
      record.artifactType,
      record.policyFingerprint,
      JSON.stringify(normalizeSessionMap(record.sessionMapAdditions)),
      now,
      now
    );
  }

  recordThreadItem(record) {
    this.assertOpen();
    this.statements.recordThreadItem.run(
      record.sessionKey,
      record.slotKey,
      record.cacheKey,
      record.contentHash,
      record.artifactType,
      Date.now()
    );
  }

  registerRepository(record) {
    this.assertOpen();
    const now = Date.now();
    const repositoryId = requiredHash(record.repositoryId, "repositoryId");
    this.statements.putRepository.run(repositoryId, opaque(record.rootRef), now, now);
    return { repositoryId, rootRef: opaque(record.rootRef) };
  }

  getRepository(repositoryId) {
    this.assertOpen();
    const row = this.statements.getRepository.get(repositoryId);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchRepository.run(Date.now(), repositoryId);
    return { repositoryId: row.repository_id, rootRef: row.root_ref };
  }

  registerWorktree(record) {
    this.assertOpen();
    const now = Date.now();
    const worktreeId = requiredHash(record.worktreeId, "worktreeId");
    const repositoryId = requiredHash(record.repositoryId, "repositoryId");
    this.statements.putWorktree.run(worktreeId, repositoryId, requiredHash(record.pathHash, "pathHash"), opaque(record.metadataRef), now, now);
    return { worktreeId, repositoryId };
  }

  getWorktree(worktreeId) {
    this.assertOpen();
    const row = this.statements.getWorktree.get(worktreeId);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchWorktree.run(Date.now(), worktreeId);
    return { worktreeId: row.worktree_id, repositoryId: row.repository_id, pathHash: row.path_hash, metadataRef: row.metadata_ref };
  }

  putContentIdentity(record) {
    this.assertOpen();
    const now = Date.now();
    const contentHash = requiredHash(record.contentHash, "contentHash");
    this.statements.putContentIdentity.run(contentHash, optionalInteger(record.byteLength), opaque(record.kind), now, now);
    if (record.gitBlobHash) this.putGitBlobAlias({ gitBlobHash: record.gitBlobHash, contentHash, repositoryId: record.repositoryId });
    return { contentHash };
  }

  putGitBlobAlias(record) {
    this.assertOpen();
    const now = Date.now();
    this.statements.putGitBlobAlias.run(requiredHash(record.gitBlobHash, "gitBlobHash"), requiredHash(record.contentHash, "contentHash"), record.repositoryId ? requiredHash(record.repositoryId, "repositoryId") : null, now, now);
  }

  getContentIdentity(contentHash) {
    this.assertOpen();
    const row = this.statements.getContentIdentity.get(contentHash);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchContentIdentity.run(Date.now(), contentHash);
    return contentIdentityRow(row);
  }

  findContentByGitBlob(gitBlobHash) {
    this.assertOpen();
    const row = this.statements.findContentByGitBlob.get(gitBlobHash);
    if (!row || this.expired(row.last_used_at)) return undefined;
    const now = Date.now();
    this.statements.touchGitBlobAlias.run(now, gitBlobHash);
    this.statements.touchContentIdentity.run(now, row.content_hash);
    return contentIdentityRow(row);
  }

  putFileMetadata(record) {
    this.assertOpen();
    const now = Date.now();
    const worktreeId = requiredHash(record.worktreeId, "worktreeId");
    const pathHash = requiredHash(record.pathHash, "pathHash");
    const contentHash = requiredHash(record.contentHash, "contentHash");
    this.statements.putFileMetadata.run(worktreeId, pathHash, contentHash, optionalInteger(record.byteLength), optionalInteger(record.mode), opaque(record.metadataRef), now, now);
    if (record.versionHash) this.statements.putFileVersion.run(worktreeId, pathHash, requiredHash(record.versionHash, "versionHash"), contentHash, record.gitBlobHash ? requiredHash(record.gitBlobHash, "gitBlobHash") : null, opaque(record.versionRef), now, now);
  }

  getFileMetadata(worktreeId, pathHash) {
    this.assertOpen();
    const row = this.statements.getFileMetadata.get(worktreeId, pathHash);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchFileMetadata.run(Date.now(), worktreeId, pathHash);
    return fileMetadataRow(row);
  }

  getFileVersion(worktreeId, pathHash, versionHash) {
    this.assertOpen();
    const row = this.statements.getFileVersion.get(worktreeId, pathHash, versionHash);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchFileVersion.run(Date.now(), worktreeId, pathHash, versionHash);
    return { worktreeId: row.worktree_id, pathHash: row.path_hash, versionHash: row.version_hash, contentHash: row.content_hash, gitBlobHash: row.git_blob_hash, versionRef: row.version_ref };
  }

  putManifest(record) {
    this.assertOpen();
    const entries = normalizeManifestEntries(record.entries);
    const manifestHash = record.manifestHash ? requiredHash(record.manifestHash, "manifestHash") : verificationFingerprint(entries);
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.statements.putManifest.run(manifestHash, requiredHash(record.worktreeId, "worktreeId"), opaque(record.metadataRef), now, now);
      this.statements.deleteManifestEntries.run(manifestHash);
      for (const entry of entries) this.statements.putManifestEntry.run(manifestHash, entry.pathHash, entry.contentHash, entry.gitBlobHash, entry.mode, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw writeError("store manifest", error);
    }
    return { manifestHash, entries };
  }

  getManifest(manifestHash) {
    this.assertOpen();
    const row = this.statements.getManifest.get(manifestHash);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchManifest.run(Date.now(), manifestHash);
    return { manifestHash: row.manifest_hash, worktreeId: row.worktree_id, metadataRef: row.metadata_ref, entries: this.statements.getManifestEntries.all(manifestHash).map(manifestEntryRow) };
  }

  putPrivacyPlan(record) {
    this.assertOpen();
    const spans = normalizePrivacySpans(record.spans);
    const editPlan = normalizeEditPlan(record.editPlan);
    const planHash = record.planHash ? requiredHash(record.planHash, "planHash") : verificationFingerprint({ spans, editPlan });
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.statements.putPrivacyPlan.run(planHash, requiredHash(record.contentHash, "contentHash"), requiredHash(record.policyFingerprint, "policyFingerprint"), now, now);
      this.statements.deletePrivacyPlanSpans.run(planHash);
      this.statements.deletePrivacyPlanEdits.run(planHash);
      for (const span of spans) this.statements.putPrivacyPlanSpan.run(planHash, span.start, span.end, span.classification, span.reference);
      for (const edit of editPlan) this.statements.putPrivacyPlanEdit.run(planHash, edit.start, edit.end, edit.classification, edit.reference);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw writeError("store privacy plan", error);
    }
    return { planHash, spans, editPlan };
  }

  getPrivacyPlan(contentHash, policyFingerprint) {
    this.assertOpen();
    const row = this.statements.getPrivacyPlan.get(contentHash, policyFingerprint);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchPrivacyPlan.run(Date.now(), row.plan_hash);
    return {
      planHash: row.plan_hash,
      contentHash: row.content_hash,
      policyFingerprint: row.policy_fingerprint,
      spans: this.statements.getPrivacyPlanSpans.all(row.plan_hash).map(privacySpanRow),
      editPlan: this.statements.getPrivacyPlanEdits.all(row.plan_hash).map(privacyEditRow)
    };
  }

  stageFileMutation(record) {
    this.assertOpen();
    const now = Date.now();
    const mutationId = requiredHash(record.mutationId, "mutationId");
    this.statements.stageFileMutation.run(mutationId, requiredHash(record.worktreeId, "worktreeId"), requiredHash(record.pathHash, "pathHash"), requiredHash(record.expectedContentHash, "expectedContentHash"), requiredHash(record.nextContentHash, "nextContentHash"), record.manifestHash ? requiredHash(record.manifestHash, "manifestHash") : null, requiredOpaqueReference(record.opaqueReference, "opaqueReference"), now, now);
    return this.getFileMutation(mutationId);
  }

  getFileMutation(mutationId) {
    this.assertOpen();
    const row = this.statements.getFileMutation.get(mutationId);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchFileMutation.run(Date.now(), mutationId);
    return fileMutationRow(row);
  }

  commitFileMutation(mutationId, actualContentHash, committedReference) {
    this.assertOpen();
    actualContentHash = requiredHash(actualContentHash, "actualContentHash");
    const row = this.statements.getFileMutation.get(mutationId);
    if (!row || row.status !== "pending") return { status: row?.status || "missing" };
    if (row.next_content_hash !== actualContentHash) return { status: "mismatch", expectedContentHash: row.next_content_hash };
    this.statements.commitFileMutation.run(committedReference == null ? null : requiredOpaqueReference(committedReference, "committedReference"), Date.now(), mutationId);
    return this.getFileMutation(mutationId);
  }

  rollbackFileMutation(mutationId) {
    this.assertOpen();
    this.statements.rollbackFileMutation.run(Date.now(), mutationId);
    return this.getFileMutation(mutationId);
  }

  expired(timestamp) {
    return Number(timestamp || 0) < Date.now() - this.maxAgeMs;
  }

  prune() {
    this.assertOpen();
    const cutoff = Date.now() - this.maxAgeMs;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.statements.deleteOldThreadItems.run(cutoff);
      this.statements.deleteOldVerifiedItems.run(cutoff);
      this.statements.deleteOldThreads.run(cutoff);
      this.statements.trimThreadItems.run(this.maxThreadItems);
      this.statements.trimVerifiedItems.run(this.maxVerifiedItems);
      this.statements.trimThreads.run(this.maxThreads);
      for (const table of LEDGER_TABLES) {
        this.statements.deleteOldLedger[table].run(cutoff);
        this.statements.trimLedger[table].run(this.maxLedgerItems);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw contextStoreError(
        "PRIVACYAI_CONTEXT_DB_WRITE_FAILED",
        "PrivacyAI could not prune its local context verification database.",
        error
      );
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  assertOpen() {
    if (this.closed) {
      throw contextStoreError(
        "PRIVACYAI_CONTEXT_DB_CLOSED",
        "PrivacyAI context verification database is closed."
      );
    }
  }
}

class MemoryContextVerificationStore {
  constructor(options = {}) {
    this.persistent = false;
    this.maxVerifiedItems = positiveInteger(
      options.maxVerifiedItems,
      DEFAULT_MAX_VERIFIED_ITEMS,
      "maxVerifiedItems"
    );
    this.maxThreadItems = positiveInteger(
      options.maxThreadItems,
      DEFAULT_MAX_THREAD_ITEMS,
      "maxThreadItems"
    );
    this.maxThreads = positiveInteger(
      options.maxThreads,
      DEFAULT_MAX_THREADS,
      "maxThreads"
    );
    this.maxAgeMs = positiveInteger(
      options.verificationMaxAgeMs,
      DEFAULT_MAX_AGE_MS,
      "verificationMaxAgeMs"
    );
    this.maxLedgerItems = positiveInteger(options.maxLedgerItems, DEFAULT_MAX_LEDGER_ITEMS, "maxLedgerItems");
    this.threads = new Map();
    this.verifications = new Map();
    this.threadItems = new Map();
    this.repositories = new Map();
    this.worktrees = new Map();
    this.contentIdentities = new Map();
    this.gitBlobAliases = new Map();
    this.fileMetadata = new Map();
    this.fileVersions = new Map();
    this.manifests = new Map();
    this.privacyPlans = new Map();
    this.fileMutations = new Map();
  }

  loadThread(sessionKey) {
    const value = this.threads.get(sessionKey);
    if (!value) return emptyThread(sessionKey);
    value.updatedAt = Date.now();
    return structuredClone(value);
  }

  saveThread(sessionKey, record = {}) {
    const value = {
      sessionKey,
      parentSessionKeys: normalizeStringArray(record.parentSessionKeys),
      sessionMap: normalizeSessionMap(record.sessionMap),
      policyFingerprint: String(record.policyFingerprint || ""),
      updatedAt: Date.now()
    };
    this.threads.set(sessionKey, structuredClone(value));
    this.prune();
    return value;
  }

  getVerification(cacheKey, policyFingerprint) {
    const value = this.verifications.get(cacheKey);
    if (!value || value.policyFingerprint !== policyFingerprint) return undefined;
    const now = Date.now();
    if (Number(value.lastUsedAt || 0) < now - this.maxAgeMs) {
      this.deleteVerification(cacheKey);
      return undefined;
    }
    value.lastUsedAt = now;
    value.hitCount = Number(value.hitCount || 0) + 1;
    return structuredClone(stripMemoryMetadata(value));
  }

  putVerification(record) {
    const now = Date.now();
    const existing = this.verifications.get(record.cacheKey);
    this.verifications.set(record.cacheKey, {
      ...structuredClone(record),
      createdAt: Number(existing?.createdAt || now),
      lastUsedAt: now,
      hitCount: Number(existing?.hitCount || 0)
    });
    this.prune();
  }

  recordThreadItem(record) {
    this.threadItems.set(`${record.sessionKey}\0${record.slotKey}`, {
      ...structuredClone(record),
      lastSeenAt: Date.now()
    });
    this.prune();
  }

  registerRepository(record) {
    const repositoryId = requiredHash(record.repositoryId, "repositoryId");
    const value = { repositoryId, rootRef: opaque(record.rootRef), lastUsedAt: Date.now() };
    this.repositories.set(repositoryId, value);
    this.prune();
    return withoutLastUsed(value);
  }

  getRepository(repositoryId) {
    return this.getFresh(this.repositories, repositoryId, withoutLastUsed);
  }

  registerWorktree(record) {
    const worktreeId = requiredHash(record.worktreeId, "worktreeId");
    const value = { worktreeId, repositoryId: requiredHash(record.repositoryId, "repositoryId"), pathHash: requiredHash(record.pathHash, "pathHash"), metadataRef: opaque(record.metadataRef), lastUsedAt: Date.now() };
    this.worktrees.set(worktreeId, value);
    this.prune();
    return withoutLastUsed(value);
  }

  getWorktree(worktreeId) {
    return this.getFresh(this.worktrees, worktreeId, withoutLastUsed);
  }

  putContentIdentity(record) {
    const contentHash = requiredHash(record.contentHash, "contentHash");
    this.contentIdentities.set(contentHash, { contentHash, byteLength: optionalInteger(record.byteLength), kind: opaque(record.kind), lastUsedAt: Date.now() });
    if (record.gitBlobHash) this.putGitBlobAlias({ gitBlobHash: record.gitBlobHash, contentHash, repositoryId: record.repositoryId });
    this.prune();
    return { contentHash };
  }

  putGitBlobAlias(record) {
    const gitBlobHash = requiredHash(record.gitBlobHash, "gitBlobHash");
    this.gitBlobAliases.set(gitBlobHash, { gitBlobHash, contentHash: requiredHash(record.contentHash, "contentHash"), repositoryId: record.repositoryId ? requiredHash(record.repositoryId, "repositoryId") : null, lastUsedAt: Date.now() });
    this.prune();
  }

  getContentIdentity(contentHash) {
    return this.getFresh(this.contentIdentities, contentHash, value => ({ contentHash: value.contentHash, byteLength: value.byteLength, kind: value.kind }));
  }

  findContentByGitBlob(gitBlobHash) {
    const alias = this.getFresh(this.gitBlobAliases, gitBlobHash);
    return alias ? this.getContentIdentity(alias.contentHash) : undefined;
  }
  putFileMetadata(record) {
    const worktreeId = requiredHash(record.worktreeId, "worktreeId");
    const pathHash = requiredHash(record.pathHash, "pathHash");
    const contentHash = requiredHash(record.contentHash, "contentHash");
    const key = compoundKey(worktreeId, pathHash);
    this.fileMetadata.set(key, { worktreeId, pathHash, contentHash, byteLength: optionalInteger(record.byteLength), mode: optionalInteger(record.mode), metadataRef: opaque(record.metadataRef), lastUsedAt: Date.now() });
    if (record.versionHash) this.fileVersions.set(compoundKey(key, requiredHash(record.versionHash, "versionHash")), { worktreeId, pathHash, versionHash: record.versionHash, contentHash, gitBlobHash: record.gitBlobHash ? requiredHash(record.gitBlobHash, "gitBlobHash") : null, versionRef: opaque(record.versionRef), lastUsedAt: Date.now() });
    this.prune();
  }

  getFileMetadata(worktreeId, pathHash) {
    return this.getFresh(this.fileMetadata, compoundKey(worktreeId, pathHash), withoutLastUsed);
  }

  getFileVersion(worktreeId, pathHash, versionHash) {
    return this.getFresh(this.fileVersions, compoundKey(compoundKey(worktreeId, pathHash), versionHash), withoutLastUsed);
  }

  putManifest(record) {
    const entries = normalizeManifestEntries(record.entries);
    const manifestHash = record.manifestHash ? requiredHash(record.manifestHash, "manifestHash") : verificationFingerprint(entries);
    this.manifests.set(manifestHash, { manifestHash, worktreeId: requiredHash(record.worktreeId, "worktreeId"), metadataRef: opaque(record.metadataRef), entries, lastUsedAt: Date.now() });
    this.prune();
    return { manifestHash, entries };
  }

  getManifest(manifestHash) {
    return this.getFresh(this.manifests, manifestHash, withoutLastUsed);
  }
  putPrivacyPlan(record) {
    const spans = normalizePrivacySpans(record.spans);
    const editPlan = normalizeEditPlan(record.editPlan);
    const contentHash = requiredHash(record.contentHash, "contentHash");
    const policyFingerprint = requiredHash(record.policyFingerprint, "policyFingerprint");
    const planHash = record.planHash ? requiredHash(record.planHash, "planHash") : verificationFingerprint({ spans, editPlan });
    this.privacyPlans.set(compoundKey(contentHash, policyFingerprint), { planHash, contentHash, policyFingerprint, spans, editPlan, lastUsedAt: Date.now() });
    this.prune();
    return { planHash, spans, editPlan };
  }

  getPrivacyPlan(contentHash, policyFingerprint) {
    return this.getFresh(this.privacyPlans, compoundKey(contentHash, policyFingerprint), withoutLastUsed);
  }

  stageFileMutation(record) {
    const mutationId = requiredHash(record.mutationId, "mutationId");
    const value = { mutationId, worktreeId: requiredHash(record.worktreeId, "worktreeId"), pathHash: requiredHash(record.pathHash, "pathHash"), expectedContentHash: requiredHash(record.expectedContentHash, "expectedContentHash"), nextContentHash: requiredHash(record.nextContentHash, "nextContentHash"), manifestHash: record.manifestHash ? requiredHash(record.manifestHash, "manifestHash") : null, opaqueReference: requiredOpaqueReference(record.opaqueReference, "opaqueReference"), committedReference: null, status: "pending", lastUsedAt: Date.now() };
    this.fileMutations.set(mutationId, value);
    this.prune();
    return withoutLastUsed(value);
  }

  getFileMutation(mutationId) {
    return this.getFresh(this.fileMutations, mutationId, withoutLastUsed);
  }

  commitFileMutation(mutationId, actualContentHash, committedReference) {
    const value = this.fileMutations.get(mutationId);
    if (!value || value.status !== "pending") return { status: value?.status || "missing" };
    if (value.nextContentHash !== requiredHash(actualContentHash, "actualContentHash")) return { status: "mismatch", expectedContentHash: value.nextContentHash };
    value.status = "committed";
    value.committedReference = committedReference == null ? null : requiredOpaqueReference(committedReference, "committedReference");
    return this.getFileMutation(mutationId);
  }

  rollbackFileMutation(mutationId) {
    const value = this.fileMutations.get(mutationId);
    if (value?.status === "pending") value.status = "rolled_back";
    return this.getFileMutation(mutationId);
  }

  getFresh(map, key, project = value => structuredClone(value)) {
    const value = map.get(key);
    if (!value || this.isExpired(value)) return undefined;
    value.lastUsedAt = Date.now();
    return structuredClone(project(value));
  }

  isExpired(value) {
    return Number(value.lastUsedAt || 0) < Date.now() - this.maxAgeMs;
  }

  prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [key, value] of this.threadItems) {
      if (Number(value.lastSeenAt || 0) < cutoff) this.threadItems.delete(key);
    }
    for (const [cacheKey, value] of this.verifications) {
      if (Number(value.lastUsedAt || 0) < cutoff) this.deleteVerification(cacheKey);
    }
    for (const [sessionKey, value] of this.threads) {
      if (Number(value.updatedAt || 0) < cutoff) this.threads.delete(sessionKey);
    }

    trimMapByTimestamp(this.threadItems, this.maxThreadItems, "lastSeenAt");
    trimMapByTimestamp(this.verifications, this.maxVerifiedItems, "lastUsedAt", cacheKey => {
      this.deleteVerification(cacheKey);
    });
    trimMapByTimestamp(this.threads, this.maxThreads, "updatedAt");
    for (const map of [this.repositories, this.contentIdentities, this.manifests, this.privacyPlans, this.fileMutations]) {
      for (const [key, value] of map) if (this.isExpired(value)) map.delete(key);
      trimMapByTimestamp(map, this.maxLedgerItems, "lastUsedAt");
    }
    this.cascadeLedgerChildren();
  }

  deleteVerification(cacheKey) {
    this.verifications.delete(cacheKey);
    for (const [itemKey, item] of this.threadItems) {
      if (item.cacheKey === cacheKey) this.threadItems.delete(itemKey);
    }
  }

  cascadeLedgerChildren() {
    for (const [key, worktree] of this.worktrees) {
      if (!this.repositories.has(worktree.repositoryId)) this.worktrees.delete(key);
    }
    for (const [key, alias] of this.gitBlobAliases) {
      if (!this.contentIdentities.has(alias.contentHash) || (alias.repositoryId && !this.repositories.has(alias.repositoryId))) this.gitBlobAliases.delete(key);
    }
    for (const [key, metadata] of this.fileMetadata) {
      if (!this.worktrees.has(metadata.worktreeId) || !this.contentIdentities.has(metadata.contentHash)) this.fileMetadata.delete(key);
    }
    for (const [key, version] of this.fileVersions) {
      if (!this.fileMetadata.has(compoundKey(version.worktreeId, version.pathHash)) || !this.contentIdentities.has(version.contentHash)) this.fileVersions.delete(key);
    }
  }

  close() {
    this.threads.clear();
    this.verifications.clear();
    this.threadItems.clear();
    for (const map of [this.repositories, this.worktrees, this.contentIdentities, this.gitBlobAliases, this.fileMetadata, this.fileVersions, this.manifests, this.privacyPlans, this.fileMutations]) map.clear();
  }
}

function stripMemoryMetadata(value) {
  const { createdAt: _createdAt, lastUsedAt: _lastUsedAt, hitCount: _hitCount, ...record } = value;
  return record;
}

function trimMapByTimestamp(map, limit, field, remove = key => map.delete(key)) {
  if (map.size <= limit) return;
  const stale = [...map.entries()]
    .sort((left, right) => Number(right[1]?.[field] || 0) - Number(left[1]?.[field] || 0))
    .slice(limit);
  for (const [key] of stale) remove(key);
}

function initializeSchema(database) {
  database.exec("CREATE TABLE IF NOT EXISTS privacyai_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const current = database.prepare("SELECT value FROM privacyai_meta WHERE key = 'schema_version'").get();
  const version = current ? Number(current.value) : 0;
  if (version > SCHEMA_VERSION || !Number.isSafeInteger(version)) {
    throw contextStoreError("PRIVACYAI_CONTEXT_DB_SCHEMA_UNSUPPORTED", "PrivacyAI context verification database uses an unsupported schema version.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
    CREATE TABLE IF NOT EXISTS privacyai_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      session_key TEXT PRIMARY KEY,
      parent_keys_json TEXT NOT NULL,
      session_map_json TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verified_items (
      cache_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      additions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS verified_items_lru_idx
      ON verified_items(last_used_at);
    CREATE TABLE IF NOT EXISTS thread_items (
      session_key TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(session_key, slot_key),
      FOREIGN KEY(session_key) REFERENCES threads(session_key) ON DELETE CASCADE,
      FOREIGN KEY(cache_key) REFERENCES verified_items(cache_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS thread_items_seen_idx
      ON thread_items(last_seen_at);
    CREATE INDEX IF NOT EXISTS threads_updated_idx ON threads(updated_at);
    CREATE TABLE IF NOT EXISTS ledger_repositories (
      repository_id TEXT PRIMARY KEY, root_ref TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_repositories_lru_idx ON ledger_repositories(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_worktrees (
      worktree_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES ledger_repositories(repository_id) ON DELETE CASCADE,
      path_hash TEXT NOT NULL, metadata_ref TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_worktrees_repo_path_idx ON ledger_worktrees(repository_id, path_hash);
    CREATE INDEX IF NOT EXISTS ledger_worktrees_lru_idx ON ledger_worktrees(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_content_identities (
      content_hash TEXT PRIMARY KEY, byte_length INTEGER, kind TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_content_lru_idx ON ledger_content_identities(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_git_blob_aliases (
      git_blob_hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
      repository_id TEXT REFERENCES ledger_repositories(repository_id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_git_blob_content_idx ON ledger_git_blob_aliases(content_hash);
    CREATE INDEX IF NOT EXISTS ledger_git_blob_lru_idx ON ledger_git_blob_aliases(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_file_metadata (
      worktree_id TEXT NOT NULL REFERENCES ledger_worktrees(worktree_id) ON DELETE CASCADE, path_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE, byte_length INTEGER, mode INTEGER,
      metadata_ref TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, PRIMARY KEY(worktree_id, path_hash)
    );
    CREATE INDEX IF NOT EXISTS ledger_file_metadata_content_idx ON ledger_file_metadata(content_hash);
    CREATE INDEX IF NOT EXISTS ledger_file_metadata_lru_idx ON ledger_file_metadata(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_file_versions (
      worktree_id TEXT NOT NULL, path_hash TEXT NOT NULL, version_hash TEXT NOT NULL, content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
      git_blob_hash TEXT, version_ref TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      PRIMARY KEY(worktree_id, path_hash, version_hash), FOREIGN KEY(worktree_id, path_hash) REFERENCES ledger_file_metadata(worktree_id, path_hash) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ledger_file_versions_content_idx ON ledger_file_versions(content_hash);
    CREATE INDEX IF NOT EXISTS ledger_file_versions_lru_idx ON ledger_file_versions(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_manifests (
      manifest_hash TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES ledger_worktrees(worktree_id) ON DELETE CASCADE,
      metadata_ref TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_manifests_worktree_idx ON ledger_manifests(worktree_id);
    CREATE INDEX IF NOT EXISTS ledger_manifests_lru_idx ON ledger_manifests(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_manifest_entries (
      manifest_hash TEXT NOT NULL REFERENCES ledger_manifests(manifest_hash) ON DELETE CASCADE, path_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE, git_blob_hash TEXT, mode INTEGER,
      last_used_at INTEGER NOT NULL, PRIMARY KEY(manifest_hash, path_hash)
    );
    CREATE INDEX IF NOT EXISTS ledger_manifest_entries_content_idx ON ledger_manifest_entries(content_hash);
    CREATE INDEX IF NOT EXISTS ledger_manifest_entries_lru_idx ON ledger_manifest_entries(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_privacy_plans (
      plan_hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
      policy_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_privacy_plans_lookup_idx ON ledger_privacy_plans(content_hash, policy_fingerprint);
    CREATE INDEX IF NOT EXISTS ledger_privacy_plans_lru_idx ON ledger_privacy_plans(last_used_at);
    CREATE TABLE IF NOT EXISTS ledger_privacy_plan_spans (
      plan_hash TEXT NOT NULL REFERENCES ledger_privacy_plans(plan_hash) ON DELETE CASCADE,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
      classification TEXT NOT NULL, opaque_reference TEXT NOT NULL,
      PRIMARY KEY(plan_hash, start_offset, end_offset, classification, opaque_reference),
      CHECK(start_offset <= end_offset)
    );
    CREATE TABLE IF NOT EXISTS ledger_privacy_plan_edits (
      plan_hash TEXT NOT NULL REFERENCES ledger_privacy_plans(plan_hash) ON DELETE CASCADE,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
      classification TEXT NOT NULL, opaque_reference TEXT NOT NULL,
      PRIMARY KEY(plan_hash, start_offset, end_offset, classification, opaque_reference),
      CHECK(start_offset <= end_offset)
    );
    CREATE TABLE IF NOT EXISTS ledger_file_mutations (
      mutation_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES ledger_worktrees(worktree_id) ON DELETE CASCADE, path_hash TEXT NOT NULL,
      expected_content_hash TEXT NOT NULL, next_content_hash TEXT NOT NULL, manifest_hash TEXT REFERENCES ledger_manifests(manifest_hash) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'committed', 'rolled_back')), opaque_reference TEXT NOT NULL,
      committed_reference TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_file_mutations_pending_idx ON ledger_file_mutations(status, last_used_at);
    CREATE INDEX IF NOT EXISTS ledger_file_mutations_lru_idx ON ledger_file_mutations(last_used_at);
  `);
    database.prepare(`INSERT INTO privacyai_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function prepareStatements(database) {
  return {
    loadThread: database.prepare(`
      SELECT parent_keys_json, session_map_json, policy_fingerprint, updated_at
      FROM threads WHERE session_key = ?
    `),
    saveThread: database.prepare(`
      INSERT INTO threads(session_key, parent_keys_json, session_map_json, policy_fingerprint, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        parent_keys_json = excluded.parent_keys_json,
        session_map_json = excluded.session_map_json,
        policy_fingerprint = excluded.policy_fingerprint,
        updated_at = excluded.updated_at
    `),
    getVerification: database.prepare(`
      SELECT content_hash, artifact_type, policy_fingerprint, additions_json, last_used_at
      FROM verified_items WHERE cache_key = ? AND policy_fingerprint = ?
    `),
    deleteVerification: database.prepare("DELETE FROM verified_items WHERE cache_key = ?"),
    touchVerification: database.prepare(`
      UPDATE verified_items SET last_used_at = ?, hit_count = hit_count + 1 WHERE cache_key = ?
    `),
    putVerification: database.prepare(`
      INSERT INTO verified_items(
        cache_key, content_hash, artifact_type, policy_fingerprint,
        additions_json, created_at, last_used_at, hit_count
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(cache_key) DO UPDATE SET
        content_hash = excluded.content_hash,
        artifact_type = excluded.artifact_type,
        policy_fingerprint = excluded.policy_fingerprint,
        additions_json = excluded.additions_json,
        last_used_at = excluded.last_used_at
    `),
    recordThreadItem: database.prepare(`
      INSERT INTO thread_items(
        session_key, slot_key, cache_key, content_hash, artifact_type, last_seen_at
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key, slot_key) DO UPDATE SET
        cache_key = excluded.cache_key,
        content_hash = excluded.content_hash,
        artifact_type = excluded.artifact_type,
        last_seen_at = excluded.last_seen_at
    `),
    deleteOldThreadItems: database.prepare("DELETE FROM thread_items WHERE last_seen_at < ?"),
    deleteOldVerifiedItems: database.prepare(
      "DELETE FROM verified_items WHERE last_used_at < ?"
    ),
    trimThreadItems: database.prepare(`
      DELETE FROM thread_items WHERE rowid IN (
        SELECT rowid FROM thread_items ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?
      )
    `),
    trimVerifiedItems: database.prepare(`
      DELETE FROM verified_items WHERE cache_key IN (
        SELECT cache_key FROM verified_items
        ORDER BY last_used_at DESC LIMIT -1 OFFSET ?
      )
    `),
    deleteOldThreads: database.prepare("DELETE FROM threads WHERE updated_at < ?"),
    trimThreads: database.prepare("DELETE FROM threads WHERE session_key IN (SELECT session_key FROM threads ORDER BY updated_at DESC LIMIT -1 OFFSET ? )"),
    putRepository: database.prepare("INSERT INTO ledger_repositories(repository_id, root_ref, created_at, last_used_at) VALUES(?, ?, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET root_ref=excluded.root_ref,last_used_at=excluded.last_used_at"),
    getRepository: database.prepare("SELECT repository_id,root_ref,last_used_at FROM ledger_repositories WHERE repository_id=?"),
    touchRepository: database.prepare("UPDATE ledger_repositories SET last_used_at=? WHERE repository_id=?"),
    putWorktree: database.prepare("INSERT INTO ledger_worktrees(worktree_id, repository_id, path_hash, metadata_ref, created_at, last_used_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(worktree_id) DO UPDATE SET repository_id=excluded.repository_id,path_hash=excluded.path_hash,metadata_ref=excluded.metadata_ref,last_used_at=excluded.last_used_at"),
    getWorktree: database.prepare("SELECT worktree_id,repository_id,path_hash,metadata_ref,last_used_at FROM ledger_worktrees WHERE worktree_id=?"),
    touchWorktree: database.prepare("UPDATE ledger_worktrees SET last_used_at=? WHERE worktree_id=?"),
    putContentIdentity: database.prepare("INSERT INTO ledger_content_identities(content_hash, byte_length, kind, created_at, last_used_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO UPDATE SET byte_length=excluded.byte_length,kind=excluded.kind,last_used_at=excluded.last_used_at"),
    getContentIdentity: database.prepare("SELECT content_hash, byte_length, kind, last_used_at FROM ledger_content_identities WHERE content_hash=?"),
    touchContentIdentity: database.prepare("UPDATE ledger_content_identities SET last_used_at=? WHERE content_hash=?"),
    putGitBlobAlias: database.prepare("INSERT INTO ledger_git_blob_aliases(git_blob_hash, content_hash, repository_id, created_at, last_used_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(git_blob_hash) DO UPDATE SET content_hash=excluded.content_hash,repository_id=excluded.repository_id,last_used_at=excluded.last_used_at"),
    findContentByGitBlob: database.prepare("SELECT c.content_hash,c.byte_length,c.kind,a.last_used_at FROM ledger_git_blob_aliases a JOIN ledger_content_identities c ON c.content_hash=a.content_hash WHERE a.git_blob_hash=?"),
    touchGitBlobAlias: database.prepare("UPDATE ledger_git_blob_aliases SET last_used_at=? WHERE git_blob_hash=?"),
    putFileMetadata: database.prepare("INSERT INTO ledger_file_metadata(worktree_id,path_hash,content_hash,byte_length,mode,metadata_ref,created_at,last_used_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worktree_id,path_hash) DO UPDATE SET content_hash=excluded.content_hash,byte_length=excluded.byte_length,mode=excluded.mode,metadata_ref=excluded.metadata_ref,last_used_at=excluded.last_used_at"),
    getFileMetadata: database.prepare("SELECT worktree_id,path_hash,content_hash,byte_length,mode,metadata_ref,last_used_at FROM ledger_file_metadata WHERE worktree_id=? AND path_hash=?"),
    touchFileMetadata: database.prepare("UPDATE ledger_file_metadata SET last_used_at=? WHERE worktree_id=? AND path_hash=?"),
    putFileVersion: database.prepare("INSERT INTO ledger_file_versions(worktree_id,path_hash,version_hash,content_hash,git_blob_hash,version_ref,created_at,last_used_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worktree_id,path_hash,version_hash) DO UPDATE SET content_hash=excluded.content_hash,git_blob_hash=excluded.git_blob_hash,version_ref=excluded.version_ref,last_used_at=excluded.last_used_at"),
    getFileVersion: database.prepare("SELECT worktree_id,path_hash,version_hash,content_hash,git_blob_hash,version_ref,last_used_at FROM ledger_file_versions WHERE worktree_id=? AND path_hash=? AND version_hash=?"),
    touchFileVersion: database.prepare("UPDATE ledger_file_versions SET last_used_at=? WHERE worktree_id=? AND path_hash=? AND version_hash=?"),
    putManifest: database.prepare("INSERT INTO ledger_manifests(manifest_hash,worktree_id,metadata_ref,created_at,last_used_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(manifest_hash) DO UPDATE SET worktree_id=excluded.worktree_id,metadata_ref=excluded.metadata_ref,last_used_at=excluded.last_used_at"),
    deleteManifestEntries: database.prepare("DELETE FROM ledger_manifest_entries WHERE manifest_hash=?"),
    putManifestEntry: database.prepare("INSERT INTO ledger_manifest_entries(manifest_hash,path_hash,content_hash,git_blob_hash,mode,last_used_at) VALUES(?, ?, ?, ?, ?, ? )"),
    getManifest: database.prepare("SELECT manifest_hash,worktree_id,metadata_ref,last_used_at FROM ledger_manifests WHERE manifest_hash=?"),
    getManifestEntries: database.prepare("SELECT path_hash,content_hash,git_blob_hash,mode FROM ledger_manifest_entries WHERE manifest_hash=? ORDER BY path_hash"),
    touchManifest: database.prepare("UPDATE ledger_manifests SET last_used_at=? WHERE manifest_hash=?"),
    putPrivacyPlan: database.prepare("INSERT INTO ledger_privacy_plans(plan_hash,content_hash,policy_fingerprint,created_at,last_used_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(plan_hash) DO UPDATE SET content_hash=excluded.content_hash,policy_fingerprint=excluded.policy_fingerprint,last_used_at=excluded.last_used_at"),
    deletePrivacyPlanSpans: database.prepare("DELETE FROM ledger_privacy_plan_spans WHERE plan_hash=?"),
    deletePrivacyPlanEdits: database.prepare("DELETE FROM ledger_privacy_plan_edits WHERE plan_hash=?"),
    putPrivacyPlanSpan: database.prepare("INSERT INTO ledger_privacy_plan_spans(plan_hash,start_offset,end_offset,classification,opaque_reference) VALUES(?, ?, ?, ?, ?)"),
    putPrivacyPlanEdit: database.prepare("INSERT INTO ledger_privacy_plan_edits(plan_hash,start_offset,end_offset,classification,opaque_reference) VALUES(?, ?, ?, ?, ?)"),
    getPrivacyPlan: database.prepare("SELECT plan_hash,content_hash,policy_fingerprint,last_used_at FROM ledger_privacy_plans WHERE content_hash=? AND policy_fingerprint=?"),
    getPrivacyPlanSpans: database.prepare("SELECT start_offset,end_offset,classification,opaque_reference FROM ledger_privacy_plan_spans WHERE plan_hash=? ORDER BY start_offset,end_offset,classification,opaque_reference"),
    getPrivacyPlanEdits: database.prepare("SELECT start_offset,end_offset,classification,opaque_reference FROM ledger_privacy_plan_edits WHERE plan_hash=? ORDER BY start_offset,end_offset,classification,opaque_reference"),
    touchPrivacyPlan: database.prepare("UPDATE ledger_privacy_plans SET last_used_at=? WHERE plan_hash=?"),
    stageFileMutation: database.prepare("INSERT INTO ledger_file_mutations(mutation_id,worktree_id,path_hash,expected_content_hash,next_content_hash,manifest_hash,status,opaque_reference,created_at,last_used_at) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(mutation_id) DO UPDATE SET worktree_id=excluded.worktree_id,path_hash=excluded.path_hash,expected_content_hash=excluded.expected_content_hash,next_content_hash=excluded.next_content_hash,manifest_hash=excluded.manifest_hash,status='pending',opaque_reference=excluded.opaque_reference,committed_reference=NULL,last_used_at=excluded.last_used_at"),
    getFileMutation: database.prepare("SELECT mutation_id,worktree_id,path_hash,expected_content_hash,next_content_hash,manifest_hash,status,opaque_reference,committed_reference,last_used_at FROM ledger_file_mutations WHERE mutation_id=?"),
    touchFileMutation: database.prepare("UPDATE ledger_file_mutations SET last_used_at=? WHERE mutation_id=?"),
    commitFileMutation: database.prepare("UPDATE ledger_file_mutations SET status='committed',committed_reference=?,last_used_at=? WHERE mutation_id=? AND status='pending'"),
    rollbackFileMutation: database.prepare("UPDATE ledger_file_mutations SET status='rolled_back',last_used_at=? WHERE mutation_id=? AND status='pending'"),
    deleteOldLedger: Object.fromEntries(LEDGER_TABLES.map(table => [table, database.prepare(`DELETE FROM ${table} WHERE last_used_at < ?`)])),
    trimLedger: Object.fromEntries(LEDGER_TABLES.map(table => [table, database.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY last_used_at DESC LIMIT -1 OFFSET ?)`)]))
  };
}

function emptyThread(sessionKey) {
  return {
    sessionKey,
    parentSessionKeys: [],
    sessionMap: {},
    policyFingerprint: "",
    updatedAt: 0
  };
}

function parseSessionMap(serialized, label) {
  return normalizeSessionMap(parseJson(serialized, label));
}

function parseStringArray(serialized, label) {
  return normalizeStringArray(parseJson(serialized, label));
}

function parseJson(serialized, label) {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw contextStoreError(
      "PRIVACYAI_CONTEXT_DB_CORRUPT",
      `PrivacyAI found malformed ${label} in its local context database.`,
      error
    );
  }
}

function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    ([placeholder, original]) =>
      typeof placeholder === "string" && placeholder.length > 0 &&
      typeof original === "string" && original.length > 0 &&
      placeholder !== original
  ));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(entry => typeof entry === "string" && entry.length > 0))];
}

function requiredHash(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty opaque hash.`);
  return value;
}

function requiredOpaqueReference(value, name) {
  if (typeof value !== "string" || !/^sha(?:256|512):[^\s]{1,256}$/.test(value)) {
    throw new TypeError(`${name} must be an opaque hash reference.`);
  }
  return value;
}

function optionalInteger(value) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new TypeError("ledger numeric metadata must be a non-negative safe integer.");
  return normalized;
}

function opaque(value) { return typeof value === "string" ? value : ""; }

function normalizeManifestEntries(value) {
  if (!Array.isArray(value)) throw new TypeError("manifest entries must be an array.");
  const entries = value.map(entry => ({
    pathHash: requiredHash(entry?.pathHash, "pathHash"), contentHash: requiredHash(entry?.contentHash, "contentHash"),
    gitBlobHash: entry?.gitBlobHash ? requiredHash(entry.gitBlobHash, "gitBlobHash") : null, mode: optionalInteger(entry?.mode)
  })).sort((a, b) => a.pathHash.localeCompare(b.pathHash));
  if (new Set(entries.map(entry => entry.pathHash)).size !== entries.length) throw new TypeError("manifest entries must have unique path hashes.");
  return entries;
}

function normalizePrivacySpans(value) {
  if (!Array.isArray(value)) return [];
  return value.map(span => {
    const start = optionalInteger(span?.start), end = optionalInteger(span?.end);
    if (end < start || typeof span?.classification !== "string" || !span.classification) throw new TypeError("privacy spans require range and classification.");
    return { start, end, classification: span.classification, reference: requiredOpaqueReference(span.reference, "span reference") };
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.classification.localeCompare(b.classification));
}

function normalizeEditPlan(value) {
  if (!Array.isArray(value)) return [];
  return value.map(edit => {
    const start = optionalInteger(edit?.start), end = optionalInteger(edit?.end);
    if (end < start) throw new TypeError("privacy edit plan requires valid ranges.");
    if (typeof edit?.classification !== "string" || !edit.classification) throw new TypeError("privacy edit plan requires a classification.");
    return { start, end, classification: edit.classification, reference: requiredOpaqueReference(edit.reference, "edit reference") };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
}

function contentIdentityRow(row) { return { contentHash: row.content_hash, byteLength: row.byte_length, kind: row.kind }; }
function fileMetadataRow(row) { return { worktreeId: row.worktree_id, pathHash: row.path_hash, contentHash: row.content_hash, byteLength: row.byte_length, mode: row.mode, metadataRef: row.metadata_ref }; }
function manifestEntryRow(row) { return { pathHash: row.path_hash, contentHash: row.content_hash, gitBlobHash: row.git_blob_hash, mode: row.mode }; }
function privacySpanRow(row) { return { start: row.start_offset, end: row.end_offset, classification: row.classification, reference: row.opaque_reference }; }
function privacyEditRow(row) { return { start: row.start_offset, end: row.end_offset, classification: row.classification, reference: row.opaque_reference }; }
function fileMutationRow(row) { return { mutationId: row.mutation_id, worktreeId: row.worktree_id, pathHash: row.path_hash, expectedContentHash: row.expected_content_hash, nextContentHash: row.next_content_hash, manifestHash: row.manifest_hash, status: row.status, opaqueReference: row.opaque_reference, committedReference: row.committed_reference }; }
function compoundKey(...parts) { return parts.join("\0"); }
function withoutLastUsed(value) { const { lastUsedAt: _lastUsedAt, ...record } = value; return record; }
function writeError(action, cause) { return contextStoreError("PRIVACYAI_CONTEXT_DB_WRITE_FAILED", `PrivacyAI could not ${action} in its local cache ledger.`, cause); }

function positiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contextStoreError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export { MemoryContextVerificationStore, SqliteContextVerificationStore };
