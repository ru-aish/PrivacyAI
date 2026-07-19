const prepare = (database, sql) => database.prepare(sql);

export function prepareStatements(database) {
  return {
    loadThread: prepare(database, `
      SELECT parent_keys_json, session_map_json, policy_fingerprint, updated_at
      FROM threads WHERE session_key = ?
    `),
    latestThreadUpdatedAt: prepare(database, "SELECT MAX(updated_at) AS updated_at FROM threads"),
    saveThread: prepare(database, `
      INSERT INTO threads(session_key, parent_keys_json, session_map_json, policy_fingerprint, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        parent_keys_json = excluded.parent_keys_json,
        session_map_json = excluded.session_map_json,
        policy_fingerprint = excluded.policy_fingerprint,
        updated_at = excluded.updated_at
    `),

    getVerification: prepare(database, `
      SELECT content_hash, artifact_type, policy_fingerprint, additions_json, last_used_at
      FROM verified_items WHERE cache_key = ? AND policy_fingerprint = ?
    `),
    putVerification: prepare(database, `
      INSERT INTO verified_items(
        cache_key, content_hash, artifact_type, policy_fingerprint,
        additions_json, created_at, last_used_at, hit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(cache_key) DO UPDATE SET
        content_hash = excluded.content_hash,
        artifact_type = excluded.artifact_type,
        policy_fingerprint = excluded.policy_fingerprint,
        additions_json = excluded.additions_json,
        last_used_at = excluded.last_used_at
    `),
    touchVerification: prepare(database, `
      UPDATE verified_items SET last_used_at = ?, hit_count = hit_count + 1
      WHERE cache_key = ?
    `),
    deleteVerification: prepare(database, "DELETE FROM verified_items WHERE cache_key = ?"),
    recordThreadItem: prepare(database, `
      INSERT INTO thread_items(session_key, slot_key, cache_key, content_hash, artifact_type, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key, slot_key) DO UPDATE SET
        cache_key = excluded.cache_key,
        content_hash = excluded.content_hash,
        artifact_type = excluded.artifact_type,
        last_seen_at = excluded.last_seen_at
    `),

    putRepository: prepare(database, `
      INSERT INTO ledger_repositories(repository_id, root_ref, created_at, last_used_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        root_ref = excluded.root_ref, last_used_at = excluded.last_used_at
    `),
    getRepository: prepare(database, `
      SELECT repository_id, root_ref, last_used_at
      FROM ledger_repositories WHERE repository_id = ?
    `),
    touchRepository: prepare(database, "UPDATE ledger_repositories SET last_used_at = ? WHERE repository_id = ?"),

    putWorktree: prepare(database, `
      INSERT INTO ledger_worktrees(worktree_id, repository_id, path_hash, metadata_ref, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_id) DO UPDATE SET
        repository_id = excluded.repository_id,
        path_hash = excluded.path_hash,
        metadata_ref = excluded.metadata_ref,
        last_used_at = excluded.last_used_at
    `),
    getWorktree: prepare(database, `
      SELECT worktree_id, repository_id, path_hash, metadata_ref, last_used_at
      FROM ledger_worktrees WHERE worktree_id = ?
    `),
    touchWorktree: prepare(database, "UPDATE ledger_worktrees SET last_used_at = ? WHERE worktree_id = ?"),

    putContentIdentity: prepare(database, `
      INSERT INTO ledger_content_identities(content_hash, byte_length, kind, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        byte_length = excluded.byte_length, kind = excluded.kind, last_used_at = excluded.last_used_at
    `),
    getContentIdentity: prepare(database, `
      SELECT content_hash, byte_length, kind, last_used_at
      FROM ledger_content_identities WHERE content_hash = ?
    `),
    touchContentIdentity: prepare(database, "UPDATE ledger_content_identities SET last_used_at = ? WHERE content_hash = ?"),
    putGitBlobAlias: prepare(database, `
      INSERT INTO ledger_git_blob_aliases(git_blob_hash, content_hash, repository_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(git_blob_hash) DO UPDATE SET
        content_hash = excluded.content_hash,
        repository_id = excluded.repository_id,
        last_used_at = excluded.last_used_at
    `),
    findContentByGitBlob: prepare(database, `
      SELECT c.content_hash, c.byte_length, c.kind, a.last_used_at
      FROM ledger_git_blob_aliases AS a
      JOIN ledger_content_identities AS c ON c.content_hash = a.content_hash
      WHERE a.git_blob_hash = ?
    `),
    touchGitBlobAlias: prepare(database, "UPDATE ledger_git_blob_aliases SET last_used_at = ? WHERE git_blob_hash = ?"),

    putFileMetadata: prepare(database, `
      INSERT INTO ledger_file_metadata(
        worktree_id, path_hash, content_hash, byte_length, mode, metadata_ref, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_id, path_hash) DO UPDATE SET
        content_hash = excluded.content_hash,
        byte_length = excluded.byte_length,
        mode = excluded.mode,
        metadata_ref = excluded.metadata_ref,
        last_used_at = excluded.last_used_at
    `),
    getFileMetadata: prepare(database, `
      SELECT worktree_id, path_hash, content_hash, byte_length, mode, metadata_ref, last_used_at
      FROM ledger_file_metadata WHERE worktree_id = ? AND path_hash = ?
    `),
    touchFileMetadata: prepare(database, "UPDATE ledger_file_metadata SET last_used_at = ? WHERE worktree_id = ? AND path_hash = ?"),
    putFileVersion: prepare(database, `
      INSERT INTO ledger_file_versions(
        worktree_id, path_hash, version_hash, content_hash, git_blob_hash,
        version_ref, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_id, path_hash, version_hash) DO UPDATE SET
        content_hash = excluded.content_hash,
        git_blob_hash = excluded.git_blob_hash,
        version_ref = excluded.version_ref,
        last_used_at = excluded.last_used_at
    `),
    getFileVersion: prepare(database, `
      SELECT worktree_id, path_hash, version_hash, content_hash, git_blob_hash,
             version_ref, last_used_at
      FROM ledger_file_versions
      WHERE worktree_id = ? AND path_hash = ? AND version_hash = ?
    `),
    touchFileVersion: prepare(database, `
      UPDATE ledger_file_versions SET last_used_at = ?
      WHERE worktree_id = ? AND path_hash = ? AND version_hash = ?
    `),

    putManifest: prepare(database, `
      INSERT INTO ledger_manifests(manifest_hash, worktree_id, metadata_ref, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(manifest_hash) DO UPDATE SET
        worktree_id = excluded.worktree_id,
        metadata_ref = excluded.metadata_ref,
        last_used_at = excluded.last_used_at
    `),
    deleteManifestEntries: prepare(database, "DELETE FROM ledger_manifest_entries WHERE manifest_hash = ?"),
    putManifestEntry: prepare(database, `
      INSERT INTO ledger_manifest_entries(
        manifest_hash, path_hash, content_hash, git_blob_hash, mode, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    getManifest: prepare(database, `
      SELECT manifest_hash, worktree_id, metadata_ref, last_used_at
      FROM ledger_manifests WHERE manifest_hash = ?
    `),
    getManifestEntries: prepare(database, `
      SELECT path_hash, content_hash, git_blob_hash, mode
      FROM ledger_manifest_entries WHERE manifest_hash = ? ORDER BY path_hash
    `),
    touchManifest: prepare(database, "UPDATE ledger_manifests SET last_used_at = ? WHERE manifest_hash = ?"),

    putPrivacyPlan: prepare(database, `
      INSERT INTO ledger_privacy_plans(plan_hash, content_hash, policy_fingerprint, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plan_hash) DO UPDATE SET
        content_hash = excluded.content_hash,
        policy_fingerprint = excluded.policy_fingerprint,
        last_used_at = excluded.last_used_at
    `),
    deletePrivacyPlanSpans: prepare(database, "DELETE FROM ledger_privacy_plan_spans WHERE plan_hash = ?"),
    deletePrivacyPlanEdits: prepare(database, "DELETE FROM ledger_privacy_plan_edits WHERE plan_hash = ?"),
    putPrivacyPlanSpan: prepare(database, `
      INSERT INTO ledger_privacy_plan_spans(plan_hash, start_offset, end_offset, classification, opaque_reference)
      VALUES (?, ?, ?, ?, ?)
    `),
    putPrivacyPlanEdit: prepare(database, `
      INSERT INTO ledger_privacy_plan_edits(plan_hash, start_offset, end_offset, classification, opaque_reference)
      VALUES (?, ?, ?, ?, ?)
    `),
    getPrivacyPlan: prepare(database, `
      SELECT plan_hash, content_hash, policy_fingerprint, last_used_at
      FROM ledger_privacy_plans WHERE content_hash = ? AND policy_fingerprint = ?
    `),
    getPrivacyPlanSpans: prepare(database, `
      SELECT start_offset, end_offset, classification, opaque_reference
      FROM ledger_privacy_plan_spans
      WHERE plan_hash = ? ORDER BY start_offset, end_offset, classification, opaque_reference
    `),
    getPrivacyPlanEdits: prepare(database, `
      SELECT start_offset, end_offset, classification, opaque_reference
      FROM ledger_privacy_plan_edits
      WHERE plan_hash = ? ORDER BY start_offset, end_offset, classification, opaque_reference
    `),
    touchPrivacyPlan: prepare(database, "UPDATE ledger_privacy_plans SET last_used_at = ? WHERE plan_hash = ?"),

    getFileMutation: prepare(database, `
      SELECT mutation_id, worktree_id, path_hash, expected_content_hash,
             next_content_hash, manifest_hash, status, opaque_reference,
             operation_type, source_length, next_length, committed_reference,
             last_used_at
      FROM ledger_file_mutations WHERE mutation_id = ?
    `),
    upsertFileMutation: prepare(database, `
      INSERT INTO ledger_file_mutations(
        mutation_id, worktree_id, path_hash, expected_content_hash, next_content_hash,
        manifest_hash, status, opaque_reference, operation_type, source_length,
        next_length, committed_reference, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(mutation_id) DO UPDATE SET
        worktree_id = excluded.worktree_id,
        path_hash = excluded.path_hash,
        expected_content_hash = excluded.expected_content_hash,
        next_content_hash = excluded.next_content_hash,
        manifest_hash = excluded.manifest_hash,
        status = 'pending',
        opaque_reference = excluded.opaque_reference,
        operation_type = excluded.operation_type,
        source_length = excluded.source_length,
        next_length = excluded.next_length,
        committed_reference = NULL,
        last_used_at = excluded.last_used_at
    `),
    deleteFileMutationEdits: prepare(database, "DELETE FROM ledger_file_mutation_edits WHERE mutation_id = ?"),
    putFileMutationEdit: prepare(database, `
      INSERT INTO ledger_file_mutation_edits(mutation_id, edit_index, start_offset, end_offset, inserted_length)
      VALUES (?, ?, ?, ?, ?)
    `),
    putFileMutationInsertion: prepare(database, `
      INSERT INTO ledger_file_mutation_insertions(
        mutation_id, edit_index, insertion_index, offset, length, classification, opaque_reference
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getFileMutationEdits: prepare(database, `
      SELECT mutation_id, edit_index, start_offset, end_offset, inserted_length
      FROM ledger_file_mutation_edits WHERE mutation_id = ? ORDER BY edit_index
    `),
    getFileMutationInsertions: prepare(database, `
      SELECT mutation_id, edit_index, insertion_index, offset, length, classification, opaque_reference
      FROM ledger_file_mutation_insertions
      WHERE mutation_id = ? ORDER BY edit_index, insertion_index
    `),
    touchFileMutation: prepare(database, "UPDATE ledger_file_mutations SET last_used_at = ? WHERE mutation_id = ?"),
    commitFileMutation: prepare(database, `
      UPDATE ledger_file_mutations
      SET status = 'committed', committed_reference = ?, last_used_at = ?
      WHERE mutation_id = ? AND status = 'pending'
    `),
    rollbackFileMutation: prepare(database, `
      UPDATE ledger_file_mutations SET status = 'rolled_back', last_used_at = ?
      WHERE mutation_id = ? AND status = 'pending'
    `),

    deleteOldThreadItems: prepare(database, "DELETE FROM thread_items WHERE last_seen_at < ?"),
    deleteOldVerifiedItems: prepare(database, "DELETE FROM verified_items WHERE last_used_at < ?"),
    deleteOldThreads: prepare(database, "DELETE FROM threads WHERE updated_at < ?"),
    trimThreadItems: prepare(database, `
      DELETE FROM thread_items WHERE rowid IN (
        SELECT rowid FROM thread_items ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?
      )
    `),
    trimVerifiedItems: prepare(database, `
      DELETE FROM verified_items WHERE rowid IN (
        SELECT rowid FROM verified_items ORDER BY last_used_at DESC LIMIT -1 OFFSET ?
      )
    `),
    trimThreads: prepare(database, `
      DELETE FROM threads WHERE rowid IN (
        SELECT rowid FROM threads ORDER BY updated_at DESC LIMIT -1 OFFSET ?
      )
    `),
    deleteOldLedger: Object.fromEntries(
      ["ledger_repositories", "ledger_content_identities", "ledger_manifests", "ledger_privacy_plans", "ledger_file_mutations"]
        .map(table => [table, prepare(database, `DELETE FROM ${table} WHERE last_used_at < ?`)])
    ),
    trimLedger: Object.fromEntries(
      ["ledger_repositories", "ledger_content_identities", "ledger_manifests", "ledger_privacy_plans", "ledger_file_mutations"]
        .map(table => [table, prepare(database, `
          DELETE FROM ${table} WHERE rowid IN (
            SELECT rowid FROM ${table} ORDER BY last_used_at DESC LIMIT -1 OFFSET ?
          )
        `)])
    ),
    deleteIncompleteManifests: prepare(database, `
      DELETE FROM ledger_manifests
      WHERE manifest_hash IN (
        SELECT m.manifest_hash
        FROM ledger_manifests AS m
        JOIN ledger_manifest_entries AS e ON e.manifest_hash = m.manifest_hash
        LEFT JOIN ledger_content_identities AS c ON c.content_hash = e.content_hash
        WHERE c.content_hash IS NULL
      )
    `)
  };
}
