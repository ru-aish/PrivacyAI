import { CONTEXT_SCHEMA_VERSION } from "./constants.js";
import { contextStoreError } from "./errors.js";
import { rollbackWithoutMasking } from "./transactions.js";

const sql = `
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
CREATE INDEX IF NOT EXISTS verified_items_lru_idx ON verified_items(last_used_at);
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
CREATE INDEX IF NOT EXISTS thread_items_seen_idx ON thread_items(last_seen_at);
CREATE INDEX IF NOT EXISTS threads_updated_idx ON threads(updated_at);
CREATE TABLE IF NOT EXISTS ledger_repositories (
  repository_id TEXT PRIMARY KEY,
  root_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_repositories_lru_idx ON ledger_repositories(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_worktrees (
  worktree_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES ledger_repositories(repository_id) ON DELETE CASCADE,
  path_hash TEXT NOT NULL,
  metadata_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_worktrees_repo_path_idx ON ledger_worktrees(repository_id, path_hash);
CREATE INDEX IF NOT EXISTS ledger_worktrees_lru_idx ON ledger_worktrees(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_content_identities (
  content_hash TEXT PRIMARY KEY,
  byte_length INTEGER,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_content_lru_idx ON ledger_content_identities(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_git_blob_aliases (
  git_blob_hash TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
  repository_id TEXT REFERENCES ledger_repositories(repository_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_git_blob_content_idx ON ledger_git_blob_aliases(content_hash);
CREATE INDEX IF NOT EXISTS ledger_git_blob_lru_idx ON ledger_git_blob_aliases(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_file_metadata (
  worktree_id TEXT NOT NULL REFERENCES ledger_worktrees(worktree_id) ON DELETE CASCADE,
  path_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
  byte_length INTEGER,
  mode INTEGER,
  metadata_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY(worktree_id, path_hash)
);
CREATE INDEX IF NOT EXISTS ledger_file_metadata_content_idx ON ledger_file_metadata(content_hash);
CREATE INDEX IF NOT EXISTS ledger_file_metadata_lru_idx ON ledger_file_metadata(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_file_versions (
  worktree_id TEXT NOT NULL,
  path_hash TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
  git_blob_hash TEXT,
  version_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY(worktree_id, path_hash, version_hash),
  FOREIGN KEY(worktree_id, path_hash) REFERENCES ledger_file_metadata(worktree_id, path_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ledger_file_versions_content_idx ON ledger_file_versions(content_hash);
CREATE INDEX IF NOT EXISTS ledger_file_versions_lru_idx ON ledger_file_versions(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_manifests (
  manifest_hash TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES ledger_worktrees(worktree_id) ON DELETE CASCADE,
  metadata_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_manifests_worktree_idx ON ledger_manifests(worktree_id);
CREATE INDEX IF NOT EXISTS ledger_manifests_lru_idx ON ledger_manifests(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_manifest_entries (
  manifest_hash TEXT NOT NULL REFERENCES ledger_manifests(manifest_hash) ON DELETE CASCADE,
  path_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
  git_blob_hash TEXT,
  mode INTEGER,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY(manifest_hash, path_hash)
);
CREATE INDEX IF NOT EXISTS ledger_manifest_entries_content_idx ON ledger_manifest_entries(content_hash);
CREATE INDEX IF NOT EXISTS ledger_manifest_entries_lru_idx ON ledger_manifest_entries(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_privacy_plans (
  plan_hash TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL REFERENCES ledger_content_identities(content_hash) ON DELETE CASCADE,
  policy_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_privacy_plans_lookup_idx ON ledger_privacy_plans(content_hash, policy_fingerprint);
CREATE INDEX IF NOT EXISTS ledger_privacy_plans_lru_idx ON ledger_privacy_plans(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_privacy_plan_spans (
  plan_hash TEXT NOT NULL REFERENCES ledger_privacy_plans(plan_hash) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  classification TEXT NOT NULL,
  opaque_reference TEXT NOT NULL,
  PRIMARY KEY(plan_hash, start_offset, end_offset, classification, opaque_reference),
  CHECK(start_offset <= end_offset)
);
CREATE TABLE IF NOT EXISTS ledger_privacy_plan_edits (
  plan_hash TEXT NOT NULL REFERENCES ledger_privacy_plans(plan_hash) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  classification TEXT NOT NULL,
  opaque_reference TEXT NOT NULL,
  PRIMARY KEY(plan_hash, start_offset, end_offset, classification, opaque_reference),
  CHECK(start_offset <= end_offset)
);
CREATE TABLE IF NOT EXISTS ledger_file_mutations (
  mutation_id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES ledger_worktrees(worktree_id) ON DELETE CASCADE,
  path_hash TEXT NOT NULL,
  expected_content_hash TEXT NOT NULL,
  next_content_hash TEXT NOT NULL,
  manifest_hash TEXT REFERENCES ledger_manifests(manifest_hash) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'committed', 'rolled_back')),
  opaque_reference TEXT NOT NULL,
  operation_type TEXT NOT NULL DEFAULT 'unknown',
  source_length INTEGER,
  next_length INTEGER,
  committed_reference TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_file_mutations_pending_idx ON ledger_file_mutations(status, last_used_at);
CREATE INDEX IF NOT EXISTS ledger_file_mutations_lru_idx ON ledger_file_mutations(last_used_at);
CREATE TABLE IF NOT EXISTS ledger_file_mutation_edits (
  mutation_id TEXT NOT NULL REFERENCES ledger_file_mutations(mutation_id) ON DELETE CASCADE,
  edit_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  inserted_length INTEGER NOT NULL,
  PRIMARY KEY(mutation_id, edit_index),
  CHECK(start_offset <= end_offset),
  CHECK(inserted_length >= 0)
);
CREATE TABLE IF NOT EXISTS ledger_file_mutation_insertions (
  mutation_id TEXT NOT NULL,
  edit_index INTEGER NOT NULL,
  insertion_index INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  classification TEXT NOT NULL,
  opaque_reference TEXT NOT NULL,
  PRIMARY KEY(mutation_id, edit_index, insertion_index),
  FOREIGN KEY(mutation_id, edit_index) REFERENCES ledger_file_mutation_edits(mutation_id, edit_index) ON DELETE CASCADE,
  CHECK(offset >= 0),
  CHECK(length >= 0)
);`;

export function initializeSchema(db) {
  db.exec("CREATE TABLE IF NOT EXISTS privacyai_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const meta = db.prepare("SELECT value FROM privacyai_meta WHERE key='schema_version'").get();
  const version = meta ? Number(meta.value) : 0;
  if (!Number.isSafeInteger(version) || version > CONTEXT_SCHEMA_VERSION) throw contextStoreError("PRIVACYAI_CONTEXT_DB_SCHEMA_UNSUPPORTED", "PrivacyAI context verification database uses an unsupported schema version.");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(sql);
    if (version < 3) {
      const columns = db.prepare("PRAGMA table_info(ledger_file_mutations)").all().map(c => c.name);
      for (const [name, definition] of [["operation_type", "TEXT NOT NULL DEFAULT 'unknown'"], ["source_length", "INTEGER"], ["next_length", "INTEGER"]]) if (!columns.includes(name)) db.exec(`ALTER TABLE ledger_file_mutations ADD COLUMN ${name} ${definition}`);
    }
    db.prepare("INSERT INTO privacyai_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(CONTEXT_SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (error) {
    rollbackWithoutMasking(db);
    throw error;
  }
}
