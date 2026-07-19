import { compoundKey, emptyThread, mergeThreadSessionMaps, mutationConflict, normalizeEditPlan, normalizeFileMutation, normalizeManifestEntries, normalizePrivacySpans, normalizeSessionMap, normalizeStringArray, opaque, optionalInteger, positiveInteger, requiredHash, requiredOpaqueReference, sameMutationMemory, stableJson, verificationFingerprint, withoutLastUsed } from "./domain.js";
import { DEFAULT_MAX_AGE_MS, DEFAULT_MAX_LEDGER_ITEMS, DEFAULT_MAX_THREAD_ITEMS, DEFAULT_MAX_THREADS, DEFAULT_MAX_VERIFIED_ITEMS } from "./constants.js";
import { closedError } from "./errors.js";

export class MemoryContextVerificationStore {
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
    this.threadBases = new Map();
    this.closed = false;
  }

  loadThread(sessionKey) {
    this.assertOpen();
    const value = this.threads.get(sessionKey);
    if (!value) {
      this.rememberThreadBase(sessionKey, {});
      return emptyThread(sessionKey);
    }
    value.updatedAt = Date.now();
    this.rememberThreadBase(sessionKey, value.sessionMap);
    return structuredClone(value);
  }

  saveThread(sessionKey, record = {}) {
    this.assertOpen();
    const existing = this.threads.get(sessionKey);
    const hasSessionMap = Object.hasOwn(record, "sessionMap");
    const base = hasSessionMap && this.threadBases.has(sessionKey)
      ? this.threadBases.get(sessionKey)
      : undefined;
    const value = {
      sessionKey,
      parentSessionKeys: normalizeStringArray([...(existing?.parentSessionKeys || []), ...(Array.isArray(record.parentSessionKeys) ? record.parentSessionKeys : [])]),
      sessionMap: mergeThreadSessionMaps(existing?.sessionMap || {}, record.sessionMap, base),
      policyFingerprint: String(record.policyFingerprint || existing?.policyFingerprint || ""),
      updatedAt: Date.now()
    };
    this.threads.set(sessionKey, structuredClone(value));
    if (base !== undefined) this.rememberThreadBase(sessionKey, value.sessionMap);
    this.prune();
    return value;
  }

  getVerification(cacheKey, policyFingerprint) {
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
    this.threadItems.set(`${record.sessionKey}\0${record.slotKey}`, {
      ...structuredClone(record),
      lastSeenAt: Date.now()
    });
    this.prune();
  }

  registerRepository(record) {
    this.assertOpen();
    const repositoryId = requiredHash(record.repositoryId, "repositoryId");
    const value = { repositoryId, rootRef: opaque(record.rootRef), lastUsedAt: Date.now() };
    this.repositories.set(repositoryId, value);
    this.prune();
    return withoutLastUsed(value);
  }

  getRepository(repositoryId) {
    this.assertOpen();
    return this.getFresh(this.repositories, repositoryId, withoutLastUsed);
  }

  registerWorktree(record) {
    this.assertOpen();
    const worktreeId = requiredHash(record.worktreeId, "worktreeId");
    const repositoryId = requiredHash(record.repositoryId, "repositoryId");
    const value = { worktreeId, repositoryId, pathHash: requiredHash(record.pathHash, "pathHash"), metadataRef: opaque(record.metadataRef), lastUsedAt: Date.now() };
    this.worktrees.set(worktreeId, value);
    this.prune();
    return withoutLastUsed(value);
  }

  getWorktree(worktreeId) {
    this.assertOpen();
    return this.getFresh(this.worktrees, worktreeId, withoutLastUsed);
  }

  putContentIdentity(record) {
    this.assertOpen();
    const contentHash = requiredHash(record.contentHash, "contentHash");
    const alias = record.gitBlobHash ? {
      gitBlobHash: requiredHash(record.gitBlobHash, "gitBlobHash"),
      repositoryId: record.repositoryId ? requiredHash(record.repositoryId, "repositoryId") : null
    } : null;
    this.contentIdentities.set(contentHash, { contentHash, byteLength: optionalInteger(record.byteLength), kind: opaque(record.kind), lastUsedAt: Date.now() });
    if (alias) this.gitBlobAliases.set(alias.gitBlobHash, { ...alias, contentHash, lastUsedAt: Date.now() });
    this.prune();
    return { contentHash };
  }

  putGitBlobAlias(record) {
    this.assertOpen();
    const gitBlobHash = requiredHash(record.gitBlobHash, "gitBlobHash");
    const contentHash = requiredHash(record.contentHash, "contentHash");
    const repositoryId = record.repositoryId ? requiredHash(record.repositoryId, "repositoryId") : null;
    this.gitBlobAliases.set(gitBlobHash, { gitBlobHash, contentHash, repositoryId, lastUsedAt: Date.now() });
    this.prune();
  }

  getContentIdentity(contentHash) {
    this.assertOpen();
    return this.getFresh(this.contentIdentities, contentHash, value => ({ contentHash: value.contentHash, byteLength: value.byteLength, kind: value.kind }));
  }

  findContentByGitBlob(gitBlobHash) {
    this.assertOpen();
    const alias = this.getFresh(this.gitBlobAliases, gitBlobHash);
    return alias ? this.getContentIdentity(alias.contentHash) : undefined;
  }
  putFileMetadata(record) {
    this.assertOpen();
    const worktreeId = requiredHash(record.worktreeId, "worktreeId");
    const pathHash = requiredHash(record.pathHash, "pathHash");
    const contentHash = requiredHash(record.contentHash, "contentHash");
    const key = compoundKey(worktreeId, pathHash);
    const versionHash = record.versionHash ? requiredHash(record.versionHash, "versionHash") : null;
    const gitBlobHash = record.gitBlobHash ? requiredHash(record.gitBlobHash, "gitBlobHash") : null;
    this.fileMetadata.set(key, { worktreeId, pathHash, contentHash, byteLength: optionalInteger(record.byteLength), mode: optionalInteger(record.mode), metadataRef: opaque(record.metadataRef), lastUsedAt: Date.now() });
    if (versionHash) this.fileVersions.set(compoundKey(key, versionHash), { worktreeId, pathHash, versionHash, contentHash, gitBlobHash, versionRef: opaque(record.versionRef), lastUsedAt: Date.now() });
    this.prune();
  }

  getFileMetadata(worktreeId, pathHash) {
    this.assertOpen();
    return this.getFresh(this.fileMetadata, compoundKey(worktreeId, pathHash), withoutLastUsed);
  }

  getFileVersion(worktreeId, pathHash, versionHash) {
    this.assertOpen();
    return this.getFresh(this.fileVersions, compoundKey(compoundKey(worktreeId, pathHash), versionHash), withoutLastUsed);
  }

  putManifest(record) {
    this.assertOpen();
    const entries = normalizeManifestEntries(record.entries);
    const manifestHash = record.manifestHash ? requiredHash(record.manifestHash, "manifestHash") : verificationFingerprint(entries);
    const worktreeId = requiredHash(record.worktreeId, "worktreeId");
    this.manifests.set(manifestHash, { manifestHash, worktreeId, metadataRef: opaque(record.metadataRef), entries, lastUsedAt: Date.now() });
    this.prune();
    return { manifestHash, entries };
  }

  getManifest(manifestHash) {
    this.assertOpen();
    return this.getFresh(this.manifests, manifestHash, withoutLastUsed);
  }
  putPrivacyPlan(record) {
    this.assertOpen();
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
    this.assertOpen();
    return this.getFresh(this.privacyPlans, compoundKey(contentHash, policyFingerprint), withoutLastUsed);
  }

  stageFileMutation(record) {
    this.assertOpen();
    const value = normalizeFileMutation(record);
    const existing = this.fileMutations.get(value.mutationId);
    if (existing?.status === "committed") return sameMutationMemory(existing, value) ? this.getFileMutation(value.mutationId) : mutationConflict(existing, value);
    if (existing?.status === "pending") return sameMutationMemory(existing, value) ? this.getFileMutation(value.mutationId) : mutationConflict(existing, value);
    this.fileMutations.set(value.mutationId, { ...value, committedReference: null, status: "pending", lastUsedAt: Date.now() });
    this.prune();
    return this.getFileMutation(value.mutationId);
  }

  getFileMutation(mutationId) {
    this.assertOpen();
    return this.getFresh(this.fileMutations, mutationId, withoutLastUsed);
  }

  commitFileMutation(mutationId, actualContentHash, committedReference) {
    this.assertOpen();
    const value = this.fileMutations.get(mutationId);
    const actual = requiredHash(actualContentHash, "actualContentHash");
    const reference = committedReference == null ? null : requiredOpaqueReference(committedReference, "committedReference");
    if (!value) return { status: "missing" };
    if (value.status === "committed") {
      if (value.nextContentHash !== actual) return { status: "mismatch", expectedContentHash: value.nextContentHash, actualContentHash: actual };
      return reference == null || value.committedReference === reference ? this.getFileMutation(mutationId) : { status: "conflict", reason: "committed_reference_conflict" };
    }
    if (value.status !== "pending") return { status: value.status };
    if (value.nextContentHash !== actual) return { status: "mismatch", expectedContentHash: value.nextContentHash, actualContentHash: actual };
    value.status = "committed";
    value.committedReference = reference;
    return this.getFileMutation(mutationId);
  }

  rollbackFileMutation(mutationId) {
    this.assertOpen();
    const value = this.fileMutations.get(mutationId);
    if (!value) return { status: "missing" };
    if (value.status === "committed") return { status: "conflict", reason: "already_committed" };
    if (value.status === "pending") value.status = "rolled_back";
    return this.getFileMutation(mutationId);
  }

  getFresh(map, key, project = value => structuredClone(value)) {
    const value = map.get(key);
    if (!value) return undefined;
    if (this.isExpired(value)) {
      map.delete(key);
      this.cascadeLedgerChildren();
      return undefined;
    }
    value.lastUsedAt = Date.now();
    return structuredClone(project(value));
  }

  isExpired(value) {
    return Number(value.lastUsedAt || 0) < Date.now() - this.maxAgeMs;
  }

  prune() {
    this.assertOpen();
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [key, value] of this.threadItems) {
      if (Number(value.lastSeenAt || 0) < cutoff) this.threadItems.delete(key);
    }
    for (const [cacheKey, value] of this.verifications) {
      if (Number(value.lastUsedAt || 0) < cutoff) this.deleteVerification(cacheKey);
    }
    for (const [sessionKey, value] of this.threads) {
      if (Number(value.updatedAt || 0) < cutoff) this.deleteThread(sessionKey);
    }

    trimMapByTimestamp(this.threadItems, this.maxThreadItems, "lastSeenAt");
    trimMapByTimestamp(this.verifications, this.maxVerifiedItems, "lastUsedAt", cacheKey => {
      this.deleteVerification(cacheKey);
    });
    trimMapByTimestamp(this.threads, this.maxThreads, "updatedAt", sessionKey => {
      this.deleteThread(sessionKey);
    });
    for (const map of [this.repositories, this.worktrees, this.contentIdentities, this.gitBlobAliases, this.fileMetadata, this.fileVersions, this.manifests, this.privacyPlans, this.fileMutations]) {
      for (const [key, value] of map) if (this.isExpired(value)) map.delete(key);
      trimMapByTimestamp(map, this.maxLedgerItems, "lastUsedAt");
    }
    this.cascadeLedgerChildren();
    for (const sessionKey of this.threadBases.keys()) {
      if (!this.threads.has(sessionKey)) this.threadBases.delete(sessionKey);
    }
  }

  deleteThread(sessionKey) {
    this.threads.delete(sessionKey);
    this.threadBases.delete(sessionKey);
    for (const [itemKey, item] of this.threadItems) {
      if (item.sessionKey === sessionKey) this.threadItems.delete(itemKey);
    }
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
    // Manifests, privacy plans, and mutation records intentionally remain
    // independently usable in the in-memory fallback. Existing callers use
    // that fallback without first materializing every relational parent; each
    // collection is still age- and count-bounded above.
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.threads.clear();
    this.verifications.clear();
    this.threadItems.clear();
    this.threadBases.clear();
    for (const map of [this.repositories, this.worktrees, this.contentIdentities, this.gitBlobAliases, this.fileMetadata, this.fileVersions, this.manifests, this.privacyPlans, this.fileMutations]) map.clear();
  }

  rememberThreadBase(sessionKey, sessionMap) {
    this.threadBases.delete(sessionKey);
    this.threadBases.set(sessionKey, structuredClone(normalizeSessionMap(sessionMap)));
    while (this.threadBases.size > this.maxThreads) {
      this.threadBases.delete(this.threadBases.keys().next().value);
    }
  }

  assertOpen() { if (this.closed) throw closedError(); }
}

function stripMemoryMetadata(value) {
  const { createdAt: _createdAt, lastUsedAt: _lastUsedAt, hitCount: _hitCount, ...record } = value;
  return record;
}

function trimMapByTimestamp(map, limit, field, remove = key => map.delete(key)) {
  if (map.size <= limit) return;
  const stale = [...map.entries()].sort((a, b) => Number(b[1]?.[field] || 0) - Number(a[1]?.[field] || 0)).slice(limit);
  for (const [key] of stale) remove(key);
}
