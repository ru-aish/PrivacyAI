import {
  LINEAGE_EVENT_TYPES,
  LINEAGE_REASON_CODES,
  LINEAGE_SCHEMA_VERSION,
  lineageError
} from "./domain.js";

const sqlEnum = values => values.map(value => `'${value}'`).join(",");
const EVENT_TYPES_SQL = sqlEnum(LINEAGE_EVENT_TYPES);
const REASON_CODES_SQL = sqlEnum(LINEAGE_REASON_CODES);

const TABLE_COLUMNS = Object.freeze({
  privacyai_lineage_meta: ["key", "value"],
  lineage_sessions: ["session_id", "created_event_id", "created_at"],
  lineage_values: ["value_id", "session_id", "created_event_id", "parent_value_id", "created_at"],
  lineage_placeholders: [
    "placeholder_id",
    "session_id",
    "value_id",
    "assigned_event_id",
    "public_placeholder",
    "created_at"
  ],
  lineage_events: [
    "row_id",
    "event_id",
    "schema_version",
    "session_id",
    "event_type",
    "occurred_at",
    "recorded_at",
    "parent_event_id",
    "parent_value_id",
    "value_id",
    "placeholder_id",
    "provider",
    "operation",
    "model",
    "artifact_type",
    "phase",
    "policy_ref",
    "transformation",
    "transformation_ref",
    "request_ref",
    "response_ref",
    "restoration_ref",
    "cache_ref",
    "reason_code",
    "diagnostic_code",
    "metadata_json"
  ]
});

const REQUIRED_INDEXES = Object.freeze([
  "lineage_events_session_time_idx",
  "lineage_events_value_time_idx",
  "lineage_events_parent_value_time_idx",
  "lineage_events_parent_event_time_idx",
  "lineage_events_recorded_time_idx",
  "lineage_placeholders_value_idx"
]);

const IMMUTABILITY_TRIGGERS = Object.freeze([
  "lineage_sessions_no_update",
  "lineage_sessions_no_delete",
  "lineage_values_no_update",
  "lineage_values_no_delete",
  "lineage_placeholders_no_update",
  "lineage_placeholders_no_delete",
  "lineage_events_no_update",
  "lineage_events_no_delete"
]);

const CREATE_SCHEMA_SQL = `
CREATE TABLE privacyai_lineage_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE lineage_sessions (
  session_id TEXT PRIMARY KEY,
  created_event_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(created_event_id) REFERENCES lineage_events(event_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(created_at >= 0)
);
CREATE TABLE lineage_values (
  value_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES lineage_sessions(session_id),
  created_event_id TEXT NOT NULL UNIQUE,
  parent_value_id TEXT REFERENCES lineage_values(value_id),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(created_event_id) REFERENCES lineage_events(event_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(created_at >= 0),
  CHECK(parent_value_id IS NULL OR parent_value_id <> value_id)
);
CREATE TABLE lineage_placeholders (
  placeholder_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES lineage_sessions(session_id),
  value_id TEXT NOT NULL REFERENCES lineage_values(value_id),
  assigned_event_id TEXT NOT NULL UNIQUE,
  public_placeholder TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(assigned_event_id) REFERENCES lineage_events(event_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(length(public_placeholder) BETWEEN 1 AND 256),
  CHECK(created_at >= 0)
);
CREATE TABLE lineage_events (
  row_id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES lineage_sessions(session_id) DEFERRABLE INITIALLY DEFERRED,
  event_type TEXT NOT NULL CHECK(event_type IN (${EVENT_TYPES_SQL})),
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL UNIQUE,
  parent_event_id TEXT REFERENCES lineage_events(event_id),
  parent_value_id TEXT REFERENCES lineage_values(value_id) DEFERRABLE INITIALLY DEFERRED,
  value_id TEXT REFERENCES lineage_values(value_id) DEFERRABLE INITIALLY DEFERRED,
  placeholder_id TEXT REFERENCES lineage_placeholders(placeholder_id) DEFERRABLE INITIALLY DEFERRED,
  provider TEXT,
  operation TEXT,
  model TEXT,
  artifact_type TEXT,
  phase TEXT,
  policy_ref TEXT,
  transformation TEXT,
  transformation_ref TEXT,
  request_ref TEXT,
  response_ref TEXT,
  restoration_ref TEXT,
  cache_ref TEXT,
  reason_code TEXT NOT NULL CHECK(reason_code IN (${REASON_CODES_SQL})),
  diagnostic_code TEXT,
  metadata_json TEXT NOT NULL,
  CHECK(schema_version = ${LINEAGE_SCHEMA_VERSION}),
  CHECK(event_type = 'session_created' OR parent_event_id IS NOT NULL),
  CHECK(occurred_at >= 0),
  CHECK(recorded_at >= 0)
);
CREATE INDEX lineage_events_session_time_idx
  ON lineage_events(session_id, occurred_at, row_id);
CREATE INDEX lineage_events_value_time_idx
  ON lineage_events(value_id, occurred_at, row_id);
CREATE INDEX lineage_events_parent_value_time_idx
  ON lineage_events(parent_value_id, occurred_at, row_id);
CREATE INDEX lineage_events_parent_event_time_idx
  ON lineage_events(parent_event_id, occurred_at, row_id);
CREATE INDEX lineage_events_recorded_time_idx
  ON lineage_events(recorded_at, row_id);
CREATE INDEX lineage_placeholders_value_idx
  ON lineage_placeholders(value_id, created_at, placeholder_id);
CREATE TRIGGER lineage_sessions_no_update BEFORE UPDATE ON lineage_sessions
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
CREATE TRIGGER lineage_sessions_no_delete BEFORE DELETE ON lineage_sessions
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
CREATE TRIGGER lineage_values_no_update BEFORE UPDATE ON lineage_values
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
CREATE TRIGGER lineage_values_no_delete BEFORE DELETE ON lineage_values
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
CREATE TRIGGER lineage_placeholders_no_update BEFORE UPDATE ON lineage_placeholders
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
CREATE TRIGGER lineage_placeholders_no_delete BEFORE DELETE ON lineage_placeholders
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
CREATE TRIGGER lineage_events_no_update BEFORE UPDATE ON lineage_events
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
CREATE TRIGGER lineage_events_no_delete BEFORE DELETE ON lineage_events
BEGIN SELECT RAISE(ABORT, 'lineage records are immutable'); END;
`;

export function initializeLineageSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const objects = db.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const metaExists = objects.some(object =>
      object.type === "table" && object.name === "privacyai_lineage_meta"
    );

    if (!metaExists) {
      if (objects.length > 0) {
        throw lineageError(
          "PRIVACYAI_LINEAGE_SCHEMA_INVALID",
          "PrivacyAI lineage storage contains an unrecognized schema."
        );
      }
      db.exec(CREATE_SCHEMA_SQL);
      db.prepare(
        "INSERT INTO privacyai_lineage_meta(key, value) VALUES('schema_version', ?)"
      ).run(String(LINEAGE_SCHEMA_VERSION));
    } else {
      validateSchemaVersion(db);
    }

    db.exec("COMMIT");
  } catch (error) {
    rollbackWithoutMasking(db);
    if (String(error?.code || "").startsWith("PRIVACYAI_LINEAGE_")) throw error;
    if (isBusy(error)) throw error;
    throw lineageError(
      "PRIVACYAI_LINEAGE_SCHEMA_INVALID",
      "PrivacyAI could not initialize its lineage schema.",
      error
    );
  }
  validateLineageSchema(db);
}

function isBusy(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED" ||
    message.includes("database is locked") || message.includes("database is busy");
}

function validateSchemaVersion(db) {
  const meta = db.prepare(
    "SELECT value FROM privacyai_lineage_meta WHERE key = 'schema_version'"
  ).get();
  const version = Number(meta?.value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_CORRUPT",
      "PrivacyAI lineage storage contains invalid schema metadata."
    );
  }
  if (version > LINEAGE_SCHEMA_VERSION) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_SCHEMA_UNSUPPORTED",
      "PrivacyAI lineage storage uses a newer unsupported schema version."
    );
  }
  if (version < LINEAGE_SCHEMA_VERSION) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_SCHEMA_MIGRATION_REQUIRED",
      "PrivacyAI lineage storage requires a migration that this release does not provide."
    );
  }
}

export function validateLineageSchema(db) {
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_SCHEMA_INVALID",
        "PrivacyAI lineage storage does not match its declared schema."
      );
    }
  }

  const indexes = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index'"
  ).all().map(row => row.name));
  if (REQUIRED_INDEXES.some(name => !indexes.has(name))) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_SCHEMA_INVALID",
      "PrivacyAI lineage storage is missing required indexes."
    );
  }

  const triggers = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
  ).all().map(row => row.name));
  if (IMMUTABILITY_TRIGGERS.some(name => !triggers.has(name))) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_SCHEMA_INVALID",
      "PrivacyAI lineage storage is missing immutability protections."
    );
  }

  const quickCheck = db.prepare("PRAGMA quick_check(1)").get();
  if (!quickCheck || Object.values(quickCheck)[0] !== "ok") {
    throw lineageError(
      "PRIVACYAI_LINEAGE_CORRUPT",
      "PrivacyAI lineage storage failed SQLite integrity checks."
    );
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_CORRUPT",
      "PrivacyAI lineage storage contains invalid relationships."
    );
  }
}

function rollbackWithoutMasking(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the stable lineage error instead of exposing SQLite details.
  }
}
