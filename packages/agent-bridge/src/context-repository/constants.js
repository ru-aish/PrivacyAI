export const DEFAULT_MAX_VERIFIED_ITEMS = 10_000;
export const DEFAULT_MAX_THREAD_ITEMS = 50_000;
export const DEFAULT_MAX_THREADS = 10_000;
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_LEDGER_ITEMS = 100_000;
export const CONTEXT_SCHEMA_VERSION = 3;
export const LEDGER_ROOT_TABLES = Object.freeze([
  "ledger_repositories", "ledger_content_identities", "ledger_manifests",
  "ledger_privacy_plans", "ledger_file_mutations"
]);
export const CONTEXT_TABLES = Object.freeze([
  "threads", "verified_items", "thread_items", "ledger_repositories", "ledger_worktrees",
  "ledger_content_identities", "ledger_git_blob_aliases", "ledger_file_metadata",
  "ledger_file_versions", "ledger_manifests", "ledger_manifest_entries", "ledger_privacy_plans",
  "ledger_privacy_plan_spans", "ledger_privacy_plan_edits", "ledger_file_mutations",
  "ledger_file_mutation_edits", "ledger_file_mutation_insertions"
]);
