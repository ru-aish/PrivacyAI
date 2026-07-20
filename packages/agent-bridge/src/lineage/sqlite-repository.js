import { stableJson } from "../context-repository/domain.js";
import { withImmediateTransaction } from "../context-repository/transactions.js";
import {
  isValueOriginEvent,
  lineageError,
  normalizeEvent,
  opaqueIdentity,
  parseStoredEvent
} from "./domain.js";
import { isSqliteContention, retryLineageContention } from "./retry.js";

const EVENT_SELECT = `
SELECT
  e.event_id,
  e.schema_version,
  e.session_id,
  e.event_type,
  e.occurred_at,
  e.recorded_at,
  e.parent_event_id,
  e.parent_value_id,
  e.value_id,
  e.placeholder_id,
  p.public_placeholder AS placeholder,
  e.provider,
  e.operation,
  e.model,
  e.artifact_type,
  e.phase,
  e.policy_ref,
  e.transformation,
  e.transformation_ref,
  e.request_ref,
  e.response_ref,
  e.restoration_ref,
  e.cache_ref,
  e.reason_code,
  e.diagnostic_code,
  e.metadata_json
FROM lineage_events e
LEFT JOIN lineage_placeholders p ON p.placeholder_id = e.placeholder_id`;

export class SqliteLineageRepository {
  constructor(database, path, options = {}) {
    this.database = database;
    this.path = path;
    this.persistent = true;
    this.closed = false;
    this.clock = typeof options.clock === "function" ? options.clock : Date.now;
    this.busyRetryTimeoutMs = positiveDuration(options.lineageRetryTimeoutMs, 10_000);
    this.signal = options.signal;
    this.readOnly = options.readOnly === true;
    this.statements = prepareStatements(database, this.readOnly);
  }

  async append(input, options = {}) {
    this.assertOpen();
    const candidate = normalizeEvent(input, { now: this.clock });
    const signal = options.signal || this.signal;
    if (this.readOnly) throw lineageError("PRIVACYAI_LINEAGE_READ_ONLY", "PrivacyAI lineage inspection is read-only.");
    return retryLineageContention(() => this.#appendOnce(candidate), {
      timeoutMs: this.busyRetryTimeoutMs,
      signal
    });
  }

  #appendOnce(candidate) {
    try {
      return withImmediateTransaction(this.database, () => {
        this.#assertAppendable(candidate);
        const latestRecordedAt = Number(this.statements.latestRecordedAt.get()?.recorded_at || 0);
        const recordedAt = Math.max(safeClock(this.clock), latestRecordedAt + 1);
        const event = Object.freeze({
          ...candidate,
          recordedAt,
          metadata: Object.freeze({ ...candidate.metadata })
        });

        this.statements.insertEvent.run(
          event.eventId,
          event.schemaVersion,
          event.sessionId,
          event.eventType,
          event.occurredAt,
          event.recordedAt,
          event.parentEventId,
          event.parentValueId,
          event.valueId,
          event.placeholderId,
          event.provider,
          event.operation,
          event.model,
          event.artifactType,
          event.phase,
          event.policyRef,
          event.transformation,
          event.transformationRef,
          event.requestRef,
          event.responseRef,
          event.restorationRef,
          event.cacheRef,
          event.reasonCode,
          event.diagnosticCode,
          stableJson(event.metadata)
        );

        if (event.eventType === "session_created") {
          this.statements.insertSession.run(event.sessionId, event.eventId, event.recordedAt);
        }
        if (isValueOriginEvent(event.eventType)) {
          this.statements.insertValue.run(
            event.valueId,
            event.sessionId,
            event.eventId,
            event.parentValueId,
            event.recordedAt
          );
        }
        if (event.eventType === "placeholder_assigned") {
          this.statements.insertPlaceholder.run(
            event.placeholderId,
            event.sessionId,
            event.valueId,
            event.eventId,
            event.placeholder,
            event.recordedAt
          );
        }

        return event;
      });
    } catch (error) {
      if (String(error?.code || "").startsWith("PRIVACYAI_LINEAGE_")) throw error;
      if (isSqliteContention(error)) throw error;
      throw lineageError(
        "PRIVACYAI_LINEAGE_WRITE_FAILED",
        "PrivacyAI could not append its local lineage event.",
        error
      );
    }
  }

  lookup(eventId) {
    this.assertOpen();
    const row = this.statements.getEvent.get(queryIdentity(eventId, "eventId"));
    return row ? parseStoredEvent(row) : undefined;
  }

  lookupSession(sessionId) {
    this.assertOpen();
    const row = this.statements.getSession.get(queryIdentity(sessionId, "sessionId"));
    return row ? Object.freeze({
      sessionId: row.session_id,
      createdEventId: row.created_event_id,
      createdAt: Number(row.created_at)
    }) : undefined;
  }

  lookupValue(valueId) {
    this.assertOpen();
    const normalized = queryIdentity(valueId, "valueId");
    const row = this.statements.getValue.get(normalized);
    if (!row) return undefined;
    const placeholders = this.statements.getValuePlaceholders.all(normalized).map(placeholderRow);
    return Object.freeze({
      valueId: row.value_id,
      sessionId: row.session_id,
      createdEventId: row.created_event_id,
      parentValueId: row.parent_value_id,
      createdAt: Number(row.created_at),
      placeholders: Object.freeze(placeholders)
    });
  }

  lookupPlaceholder(placeholderId) {
    this.assertOpen();
    const row = this.statements.getPlaceholder.get(queryIdentity(placeholderId, "placeholderId"));
    return row ? placeholderRow(row) : undefined;
  }

  sessionTraversal(sessionId, options = {}) {
    this.assertOpen();
    const limit = queryLimit(options);
    return this.#many(
      `${EVENT_SELECT}
       WHERE e.session_id = ?
       ORDER BY e.occurred_at ASC, e.row_id ASC
       LIMIT ?`,
      queryIdentity(sessionId, "sessionId"),
      limit
    );
  }

  valueTraversal(valueId, options = {}) {
    this.assertOpen();
    const limit = queryLimit(options);
    const normalized = queryIdentity(valueId, "valueId");
    return this.#many(
      `${EVENT_SELECT}
       WHERE e.value_id = ? OR e.parent_value_id = ? OR p.value_id = ?
       ORDER BY e.occurred_at ASC, e.row_id ASC
       LIMIT ?`,
      normalized,
      normalized,
      normalized,
      limit
    );
  }

  causalTraversal(eventId, options = {}) {
    this.assertOpen();
    const limit = queryLimit(options);
    const chain = [];
    const seen = new Set();
    let current = queryIdentity(eventId, "eventId");

    while (current) {
      if (seen.has(current)) {
        throw lineageError(
          "PRIVACYAI_LINEAGE_CORRUPT",
          "PrivacyAI lineage storage contains an invalid causal chain."
        );
      }
      if (chain.length >= limit) {
        throw lineageError(
          "PRIVACYAI_LINEAGE_INVALID_QUERY",
          "Lineage causal traversal exceeded the requested limit."
        );
      }
      seen.add(current);
      const event = this.lookup(current);
      if (!event) {
        if (chain.length === 0) return [];
        throw lineageError(
          "PRIVACYAI_LINEAGE_CORRUPT",
          "PrivacyAI lineage storage contains a missing causal event."
        );
      }
      chain.push(event);
      current = event.parentEventId;
    }

    return chain.reverse();
  }

  chronological(options = {}) {
    return [...this.iterateChronological(options)];
  }

  *iterateChronological(options = {}) {
    this.assertOpen();
    const limit = queryLimit(options, ["limit", "fromOccurredAt", "toOccurredAt"]);
    const from = optionalQueryTimestamp(options.fromOccurredAt, 0, "fromOccurredAt");
    const to = optionalQueryTimestamp(
      options.toOccurredAt,
      Number.MAX_SAFE_INTEGER,
      "toOccurredAt"
    );
    if (from > to) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_INVALID_QUERY",
        "Lineage chronological range is invalid."
      );
    }

    const rows = this.database.prepare(
      `${EVENT_SELECT}
       WHERE e.occurred_at >= ? AND e.occurred_at <= ?
       ORDER BY e.occurred_at ASC, e.row_id ASC
       LIMIT ?`
    ).iterate(from, to, limit);
    for (const row of rows) yield parseStoredEvent(row);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  assertOpen() {
    if (this.closed) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_CLOSED",
        "PrivacyAI lineage repository is closed."
      );
    }
  }

  #assertAppendable(event) {
    if (this.statements.eventExists.get(event.eventId)) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_DUPLICATE_EVENT",
        "PrivacyAI lineage event ID already exists."
      );
    }

    const parentEvent = event.parentEventId
      ? this.statements.eventExists.get(event.parentEventId)
      : undefined;
    if (event.parentEventId && !parentEvent) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_INVALID_PARENT",
        "PrivacyAI lineage event refers to a missing parent event."
      );
    }

    const session = this.statements.sessionExists.get(event.sessionId);
    if (event.eventType === "session_created") {
      if (session) {
        throw lineageError(
          "PRIVACYAI_LINEAGE_DUPLICATE_SESSION",
          "PrivacyAI lineage session identity already exists."
        );
      }
    } else if (!session) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_MISSING_SESSION",
        "PrivacyAI lineage event refers to a missing session."
      );
    }

    if (event.parentValueId && !this.statements.valueExists.get(event.parentValueId)) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_INVALID_PARENT",
        "PrivacyAI lineage event refers to a missing parent value."
      );
    }

    if (isValueOriginEvent(event.eventType)) {
      if (this.statements.valueExists.get(event.valueId)) {
        throw lineageError(
          "PRIVACYAI_LINEAGE_DUPLICATE_VALUE",
          "PrivacyAI protected-value identity already exists."
        );
      }
    } else if (event.valueId && !this.statements.valueExists.get(event.valueId)) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_MISSING_VALUE",
        "PrivacyAI lineage event refers to a missing protected value."
      );
    }

    const placeholder = event.placeholderId
      ? this.statements.getPlaceholder.get(event.placeholderId)
      : undefined;
    if (event.eventType === "placeholder_assigned") {
      if (placeholder) {
        throw lineageError(
          "PRIVACYAI_LINEAGE_DUPLICATE_PLACEHOLDER",
          "PrivacyAI placeholder identity already exists."
        );
      }
    } else if (event.placeholderId && !placeholder) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_MISSING_PLACEHOLDER",
        "PrivacyAI lineage event refers to a missing placeholder."
      );
    }

    if (placeholder && event.valueId && placeholder.value_id !== event.valueId) {
      throw lineageError(
        "PRIVACYAI_LINEAGE_PLACEHOLDER_VALUE_MISMATCH",
        "PrivacyAI lineage placeholder does not represent the referenced value."
      );
    }
  }

  #many(sql, ...args) {
    this.assertOpen();
    return this.database.prepare(sql).all(...args).map(parseStoredEvent);
  }
}


function positiveDuration(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 60_000) {
    throw lineageError("PRIVACYAI_LINEAGE_INVALID_OPTIONS", "lineageRetryTimeoutMs must be a positive integer no greater than 60000.");
  }
  return number;
}

function prepareStatements(database, readOnly = false) {
  const statements = {
    latestRecordedAt: database.prepare(
      "SELECT recorded_at FROM lineage_events ORDER BY recorded_at DESC LIMIT 1"
    ),
    eventExists: database.prepare(
      "SELECT event_id FROM lineage_events WHERE event_id = ?"
    ),
    sessionExists: database.prepare(
      "SELECT session_id FROM lineage_sessions WHERE session_id = ?"
    ),
    valueExists: database.prepare(
      "SELECT value_id FROM lineage_values WHERE value_id = ?"
    ),
    getEvent: database.prepare(`${EVENT_SELECT} WHERE e.event_id = ?`),
    getSession: database.prepare(
      "SELECT session_id, created_event_id, created_at FROM lineage_sessions WHERE session_id = ?"
    ),
    getValue: database.prepare(
      `SELECT value_id, session_id, created_event_id, parent_value_id, created_at
       FROM lineage_values WHERE value_id = ?`
    ),
    getPlaceholder: database.prepare(
      `SELECT placeholder_id, session_id, value_id, assigned_event_id,
              public_placeholder, created_at
       FROM lineage_placeholders WHERE placeholder_id = ?`
    ),
    getValuePlaceholders: database.prepare(
      `SELECT placeholder_id, session_id, value_id, assigned_event_id,
              public_placeholder, created_at
       FROM lineage_placeholders
       WHERE value_id = ?
       ORDER BY created_at ASC, placeholder_id ASC`
    )
  };
  if (readOnly) return statements;
  return {
    ...statements,
    insertEvent: database.prepare(`
      INSERT INTO lineage_events(
        event_id, schema_version, session_id, event_type, occurred_at, recorded_at,
        parent_event_id, parent_value_id, value_id, placeholder_id,
        provider, operation, model, artifact_type, phase, policy_ref,
        transformation, transformation_ref, request_ref, response_ref,
        restoration_ref, cache_ref, reason_code, diagnostic_code, metadata_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `),
    insertSession: database.prepare(
      "INSERT INTO lineage_sessions(session_id, created_event_id, created_at) VALUES (?, ?, ?)"
    ),
    insertValue: database.prepare(
      `INSERT INTO lineage_values(
         value_id, session_id, created_event_id, parent_value_id, created_at
       ) VALUES (?, ?, ?, ?, ?)`
    ),
    insertPlaceholder: database.prepare(
      `INSERT INTO lineage_placeholders(
         placeholder_id, session_id, value_id, assigned_event_id,
         public_placeholder, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
  };
}

function placeholderRow(row) {
  return Object.freeze({
    placeholderId: row.placeholder_id,
    sessionId: row.session_id,
    valueId: row.value_id,
    assignedEventId: row.assigned_event_id,
    placeholder: row.public_placeholder,
    createdAt: Number(row.created_at)
  });
}

function queryIdentity(value, name) {
  try {
    return opaqueIdentity(value, name);
  } catch {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_QUERY",
      `Lineage ${name} query is invalid.`
    );
  }
}

function queryLimit(options, allowed = ["limit"]) {
  assertQueryOptions(options, allowed);
  const limit = options.limit == null ? 10_000 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_QUERY",
      "Lineage query limit must be between 1 and 100000."
    );
  }
  return limit;
}

function assertQueryOptions(options, allowed) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_QUERY",
      "Lineage query options must be an object."
    );
  }
  const fields = new Set(allowed);
  const unknown = Object.keys(options).find(key => !fields.has(key));
  if (unknown) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_QUERY",
      "Lineage query options contain an unsupported field."
    );
  }
}

function optionalQueryTimestamp(value, fallback, name) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw lineageError(
      "PRIVACYAI_LINEAGE_INVALID_QUERY",
      `Lineage ${name} must be a non-negative safe integer.`
    );
  }
  return number;
}

function safeClock(clock) {
  let value;
  try {
    value = Number(clock());
  } catch {
    value = Date.now();
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}
