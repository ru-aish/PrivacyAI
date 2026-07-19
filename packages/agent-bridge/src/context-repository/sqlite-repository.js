import { prepareStatements } from "./statements.js";
import { contentIdentityRow, emptyThread, fileMetadataRow, fileMutationRow, manifestEntryRow, mergeThreadSessionMaps, normalizeEditPlan, normalizeFileMutation, normalizeManifestEntries, normalizePrivacySpans, normalizeSessionMap, normalizeStringArray, opaque, optionalInteger, parseSessionMap, parseStringArray, positiveInteger, privacyEditRow, privacySpanRow, requiredHash, requiredOpaqueReference, sameMutation, sameMutationChildren, verificationFingerprint, mutationConflict } from "./domain.js";
import { DEFAULT_MAX_AGE_MS, DEFAULT_MAX_LEDGER_ITEMS, DEFAULT_MAX_THREAD_ITEMS, DEFAULT_MAX_THREADS, DEFAULT_MAX_VERIFIED_ITEMS, LEDGER_ROOT_TABLES } from "./constants.js";
import { contextStoreError, writeError } from "./errors.js";
import { withImmediateTransaction } from "./transactions.js";

export class SqliteContextVerificationStore {
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
    this.threadBases = new Map();
    this.closed = false;
  }

  loadThread(sessionKey) {
    this.assertOpen();
    const row = this.statements.loadThread.get(sessionKey);
    if (!row) {
      this.rememberThreadBase(sessionKey, {});
      return emptyThread(sessionKey);
    }
    const sessionMap = parseSessionMap(row.session_map_json, "thread session map");
    this.rememberThreadBase(sessionKey, sessionMap);
    return {
      sessionKey,
      parentSessionKeys: parseStringArray(row.parent_keys_json, "thread parent keys"),
      sessionMap,
      policyFingerprint: String(row.policy_fingerprint || ""),
      updatedAt: Number(row.updated_at || 0)
    };
  }

  saveThread(sessionKey, record = {}) {
    this.assertOpen();
    const now = Date.now();
    const hasSessionMap = Object.hasOwn(record, "sessionMap");
    const base = hasSessionMap && this.threadBases.has(sessionKey)
      ? this.threadBases.get(sessionKey)
      : undefined;
    const saved = withImmediateTransaction(this.database, () => {
      const existing = this.statements.loadThread.get(sessionKey);
      const incomingParents = Array.isArray(record.parentSessionKeys) ? record.parentSessionKeys : [];
      const parents = normalizeStringArray([...(existing ? parseStringArray(existing.parent_keys_json, "thread parent keys") : []), ...incomingParents]);
      const currentMap = existing ? parseSessionMap(existing.session_map_json, "thread session map") : {};
      const sessionMap = mergeThreadSessionMaps(currentMap, record.sessionMap, base);
      const policyFingerprint = String(record.policyFingerprint || existing?.policy_fingerprint || "");
      this.statements.saveThread.run(sessionKey, JSON.stringify(parents), JSON.stringify(sessionMap), policyFingerprint, now);
      return { ...record, sessionKey, parentSessionKeys: parents, sessionMap, policyFingerprint, updatedAt: now };
    });
    if (base !== undefined) this.rememberThreadBase(sessionKey, saved.sessionMap);
    return saved;
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
    try {
      withImmediateTransaction(this.database, () => {
      this.statements.putContentIdentity.run(contentHash, optionalInteger(record.byteLength), opaque(record.kind), now, now);
      if (record.gitBlobHash) this.statements.putGitBlobAlias.run(requiredHash(record.gitBlobHash, "gitBlobHash"), contentHash, record.repositoryId ? requiredHash(record.repositoryId, "repositoryId") : null, now, now);
      });
    } catch (error) { throw writeError("store content identity", error); }
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
    try {
      withImmediateTransaction(this.database, () => {
        this.statements.putFileMetadata.run(worktreeId, pathHash, contentHash, optionalInteger(record.byteLength), optionalInteger(record.mode), opaque(record.metadataRef), now, now);
        if (record.versionHash) this.statements.putFileVersion.run(worktreeId, pathHash, requiredHash(record.versionHash, "versionHash"), contentHash, record.gitBlobHash ? requiredHash(record.gitBlobHash, "gitBlobHash") : null, opaque(record.versionRef), now, now);
      });
    } catch (error) { throw writeError("store file metadata", error); }
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
    try {
      withImmediateTransaction(this.database, () => {
        this.statements.putManifest.run(manifestHash, requiredHash(record.worktreeId, "worktreeId"), opaque(record.metadataRef), now, now);
        this.statements.deleteManifestEntries.run(manifestHash);
        for (const entry of entries) this.statements.putManifestEntry.run(manifestHash, entry.pathHash, entry.contentHash, entry.gitBlobHash, entry.mode, now);
      });
    } catch (error) {
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
    try {
      withImmediateTransaction(this.database, () => {
        this.statements.putPrivacyPlan.run(planHash, requiredHash(record.contentHash, "contentHash"), requiredHash(record.policyFingerprint, "policyFingerprint"), now, now);
        this.statements.deletePrivacyPlanSpans.run(planHash);
        this.statements.deletePrivacyPlanEdits.run(planHash);
        for (const span of spans) this.statements.putPrivacyPlanSpan.run(planHash, span.start, span.end, span.classification, span.reference);
        for (const edit of editPlan) this.statements.putPrivacyPlanEdit.run(planHash, edit.start, edit.end, edit.classification, edit.reference);
      });
    } catch (error) {
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
    const value = normalizeFileMutation(record);
    const now = Date.now();
    try {
      const result = withImmediateTransaction(this.database, () => {
        const existing = this.statements.getFileMutation.get(value.mutationId);
        if (existing?.status === "committed" || existing?.status === "pending") {
          const unchanged = sameMutation(existing, value) && sameMutationChildren(this.statements, value);
          return unchanged ? this.getFileMutation(value.mutationId) : mutationConflict(existing, value);
        }
        this.statements.upsertFileMutation.run(value.mutationId, value.worktreeId, value.pathHash, value.expectedContentHash, value.nextContentHash, value.manifestHash, value.opaqueReference, value.operationType, value.sourceLength, value.nextLength, now, now);
        this.statements.deleteFileMutationEdits.run(value.mutationId);
        for (const [editIndex, edit] of value.edits.entries()) {
          this.statements.putFileMutationEdit.run(value.mutationId, editIndex, edit.start, edit.end, edit.insertedLength);
          for (const [insertionIndex, insertion] of edit.knownInsertions.entries()) this.statements.putFileMutationInsertion.run(value.mutationId, editIndex, insertionIndex, insertion.offset, insertion.length, insertion.classification, insertion.reference);
        }
        return null;
      });
      if (result) return result;
    } catch (error) {
      throw writeError("stage file mutation", error);
    }
    return this.getFileMutation(value.mutationId);
  }

  getFileMutation(mutationId) {
    this.assertOpen();
    const row = this.statements.getFileMutation.get(mutationId);
    if (!row || this.expired(row.last_used_at)) return undefined;
    this.statements.touchFileMutation.run(Date.now(), mutationId);
    return fileMutationRow(row, this.statements.getFileMutationEdits.all(mutationId), this.statements.getFileMutationInsertions.all(mutationId));
  }

  commitFileMutation(mutationId, actualContentHash, committedReference) {
    this.assertOpen();
    actualContentHash = requiredHash(actualContentHash, "actualContentHash");
    const reference = committedReference == null ? null : requiredOpaqueReference(committedReference, "committedReference");
    const row = this.statements.getFileMutation.get(mutationId);
    if (!row) return { status: "missing" };
    if (row.status === "committed") {
      if (row.next_content_hash !== actualContentHash) return { status: "mismatch", expectedContentHash: row.next_content_hash, actualContentHash };
      return reference == null || row.committed_reference === reference ? this.getFileMutation(mutationId) : { status: "conflict", reason: "committed_reference_conflict" };
    }
    if (row.status !== "pending") return { status: row.status };
    if (row.next_content_hash !== actualContentHash) return { status: "mismatch", expectedContentHash: row.next_content_hash, actualContentHash };
    this.statements.commitFileMutation.run(reference, Date.now(), mutationId);
    return this.getFileMutation(mutationId);
  }

  rollbackFileMutation(mutationId) {
    this.assertOpen();
    const existing = this.statements.getFileMutation.get(mutationId);
    if (!existing) return { status: "missing" };
    if (existing.status === "committed") return { status: "conflict", reason: "already_committed" };
    if (existing.status === "rolled_back") return this.getFileMutation(mutationId);
    this.statements.rollbackFileMutation.run(Date.now(), mutationId);
    return this.getFileMutation(mutationId);
  }

  expired(timestamp) {
    this.assertOpen();
    return Number(timestamp || 0) < Date.now() - this.maxAgeMs;
  }

  prune() {
    this.assertOpen();
    const cutoff = Date.now() - this.maxAgeMs;
    try {
      withImmediateTransaction(this.database, () => {
        this.statements.deleteOldThreadItems.run(cutoff);
        this.statements.deleteOldVerifiedItems.run(cutoff);
        this.statements.deleteOldThreads.run(cutoff);
        this.statements.trimThreadItems.run(this.maxThreadItems);
        this.statements.trimVerifiedItems.run(this.maxVerifiedItems);
        this.statements.trimThreads.run(this.maxThreads);
        for (const table of LEDGER_ROOT_TABLES) {
          this.statements.deleteOldLedger[table].run(cutoff);
          this.statements.trimLedger[table].run(this.maxLedgerItems);
        }
        this.statements.deleteIncompleteManifests.run();
      });
      for (const sessionKey of this.threadBases.keys()) {
        if (!this.statements.loadThread.get(sessionKey)) this.threadBases.delete(sessionKey);
      }
    } catch (error) {
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
    this.threadBases.clear();
    this.database.close();
  }

  rememberThreadBase(sessionKey, sessionMap) {
    this.threadBases.delete(sessionKey);
    this.threadBases.set(sessionKey, structuredClone(normalizeSessionMap(sessionMap)));
    while (this.threadBases.size > this.maxThreads) {
      this.threadBases.delete(this.threadBases.keys().next().value);
    }
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
