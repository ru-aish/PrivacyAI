import { access } from "node:fs/promises";

import { redactText } from "./common.mjs";

const CONTEXT_COUNT_TABLES = Object.freeze([
  "threads",
  "verified_items",
  "thread_items",
  "ledger_repositories",
  "ledger_worktrees",
  "ledger_content_identities",
  "ledger_privacy_plans",
  "ledger_file_mutations"
]);

export async function collectDatabaseDiagnostics(paths, secrets = []) {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    context: await inspectDatabase(paths?.contextDb, secrets, inspectContextDatabase),
    lineage: await inspectDatabase(paths?.lineageDb, secrets, inspectLineageDatabase)
  };
}

async function inspectDatabase(path, secrets, inspector) {
  if (!path) return { status: "missing", reason: "path_not_configured" };
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", reason: "database_not_created" };
    return unavailable(error, secrets);
  }

  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(path, { readOnly: true });
    return inspector(database);
  } catch (error) {
    return unavailable(error, secrets);
  } finally {
    try { database?.close(); } catch {}
  }
}

function inspectContextDatabase(database) {
  const tables = tableNames(database);
  const counts = {};
  for (const table of CONTEXT_COUNT_TABLES) {
    if (tables.has(table)) counts[table] = Number(database.prepare("SELECT COUNT(*) AS count FROM " + table).get()?.count || 0);
  }
  const result = {
    status: "ready",
    schemaVersion: metaValue(database, tables, "privacyai_meta", "schema_version"),
    counts,
    fileMutationStatuses: [],
    recentFileMutations: []
  };
  if (tables.has("ledger_file_mutations")) {
    result.fileMutationStatuses = database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM ledger_file_mutations
      GROUP BY status
      ORDER BY status ASC
    `).all().map(row => ({ status: String(row.status), count: Number(row.count) }));
    result.recentFileMutations = database.prepare(`
      SELECT status, operation_type, created_at, last_used_at
      FROM ledger_file_mutations
      ORDER BY last_used_at DESC
      LIMIT 20
    `).all().map(row => ({
      status: String(row.status),
      operation: String(row.operation_type || "unknown"),
      createdAt: Number(row.created_at),
      lastUsedAt: Number(row.last_used_at)
    }));
  }
  return result;
}

function inspectLineageDatabase(database) {
  const tables = tableNames(database);
  const result = {
    status: "ready",
    schemaVersion: metaValue(database, tables, "privacyai_lineage_meta", "schema_version"),
    eventCount: 0,
    diagnosticCounts: [],
    recentEvents: []
  };
  if (!tables.has("lineage_events")) return result;
  result.eventCount = Number(database.prepare("SELECT COUNT(*) AS count FROM lineage_events").get()?.count || 0);
  result.diagnosticCounts = database.prepare(`
    SELECT COALESCE(diagnostic_code, 'none') AS diagnostic_code, COUNT(*) AS count
    FROM lineage_events
    GROUP BY COALESCE(diagnostic_code, 'none')
    ORDER BY count DESC, diagnostic_code ASC
    LIMIT 50
  `).all().map(row => ({
    diagnosticCode: String(row.diagnostic_code),
    count: Number(row.count)
  }));
  result.recentEvents = database.prepare(`
    SELECT event_type, occurred_at, recorded_at, provider, operation, model,
           artifact_type, phase, reason_code, diagnostic_code
    FROM lineage_events
    ORDER BY row_id DESC
    LIMIT 50
  `).all().map(row => ({
    eventType: String(row.event_type),
    occurredAt: Number(row.occurred_at),
    recordedAt: Number(row.recorded_at),
    provider: nullable(row.provider),
    operation: nullable(row.operation),
    model: nullable(row.model),
    artifactType: nullable(row.artifact_type),
    phase: nullable(row.phase),
    reasonCode: String(row.reason_code),
    diagnosticCode: nullable(row.diagnostic_code)
  }));
  return result;
}

function tableNames(database) {
  return new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
}

function metaValue(database, tables, table, key) {
  if (!tables.has(table)) return null;
  return nullable(database.prepare("SELECT value FROM " + table + " WHERE key = ?").get(key)?.value);
}

function nullable(value) {
  return value == null ? null : String(value);
}

function unavailable(error, secrets) {
  return {
    status: "unavailable",
    errorCode: safeCode(error),
    message: redactText(error instanceof Error ? error.message : String(error), secrets).slice(0, 500)
  };
}

function safeCode(error) {
  const value = String(error?.code || "DATABASE_INSPECTION_FAILED");
  return /^[A-Z0-9_.-]{1,100}$/i.test(value) ? value : "DATABASE_INSPECTION_FAILED";
}
