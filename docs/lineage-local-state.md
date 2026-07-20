# Immutable local lineage

PrivacyAI's lineage repository records privacy-boundary relationships without
storing protected plaintext. It is a dedicated SQLite database, separate from
the mutable context/cache repository and from the encrypted or private session
vault that may hold restoration material.

```js
import {
  createLineageId,
  openLineageRepository
} from "@privacy-ai/agent-bridge/lineage";

const lineage = await openLineageRepository();
const sessionId = createLineageId("session");

const session = await lineage.append({
  sessionId,
  eventType: "session_created",
  reasonCode: "session_start"
});
```

The default path is `~/.local/share/privacyai/lineage.sqlite3`. An explicit
`lineageDbPath` option or `PRIVACYAI_LINEAGE_DB` may override it. The persistent
implementation requires a Node.js runtime that provides `node:sqlite`; it fails
with `PRIVACYAI_LINEAGE_UNAVAILABLE` rather than silently replacing durable
lineage with memory-only state.

## Domain identities

SQLite `row_id` is an internal insertion key and is never returned by the
repository. Public domain records use namespaced opaque identities whose payload
is a UUID or digest, for example:

- `session:<uuid-or-digest>`
- `event:<uuid-or-digest>`
- `value:<digest>`
- `placeholder:<digest>`
- `request:<digest>`, `response:<digest>`, `cache:<digest>`

`createLineageId(namespace)` creates UUID-backed identities for identities that
do not need deterministic allocation. Protected-value and placeholder identities
are supplied by the infrastructure-owned identity contract; this repository
does not choose their formatting, scope, or collision policy.

A `session_created` event registers a session. `value_protected` and
`value_derived` events register exactly one protected-value origin. A
`placeholder_assigned` event registers a provider-visible placeholder against an
existing protected value. Later events can only reference registered sessions,
values, placeholders, and parent events.

A provider request that uses several protected values is represented by one
`provider_request` event per value/placeholder relation. Those events share the
same opaque `requestRef`, so a dashboard can group them as one provider request
without storing the request body.

## Schema version 1

The database contains five tables:

| Table | Purpose |
|---|---|
| `privacyai_lineage_meta` | Declared database schema version. |
| `lineage_sessions` | Immutable session identity and its creating event. |
| `lineage_values` | Immutable protected-value identity, creating session/event, and optional parent value. |
| `lineage_placeholders` | Immutable placeholder identity, represented value, assigning event, and public placeholder text. |
| `lineage_events` | Append-only chronological and causal events. |

Every event stores:

- event schema version, event identity, session identity, event type;
- caller occurrence time and repository recording time;
- a causal parent event for every event except a root `session_created` event,
  plus an optional parent value;
- optional protected-value and placeholder identities;
- bounded provider, operation, model, artifact, phase, and transformation tokens;
- opaque policy, transformation, request, response, restoration, and cache references;
- a required non-sensitive `reasonCode`;
- an optional `PRIVACYAI_*` diagnostic code;
- allowlisted numeric/boolean metadata only.

Supported event types are:

- `session_created`
- `value_protected`
- `value_derived`
- `placeholder_assigned`
- `transformation`
- `provider_request`
- `provider_response`
- `cache_hit`, `cache_miss`, `cache_write`
- `restoration`, `reveal`

Event-specific validation requires the identities and opaque references needed
to make each event useful. `reasonCode` is selected from the exported
`LINEAGE_REASON_CODES` contract rather than accepting diagnostic prose. Unknown
event fields and arbitrary string metadata are rejected rather than ignored.

## What is not persisted

This module does not accept or persist:

- raw prompts or provider request bodies;
- raw responses or streaming chunks;
- protected originals, secrets, session-map values, or reveal material;
- images, file contents, or OCR text;
- arbitrary exception messages, stack traces, paths, or diagnostic prose.

The public placeholder itself may be stored because it is already the
provider-visible safe alias. It is validated through the SDK session-map
placeholder contract. The repository cannot prove that a caller has correctly
classified every token field; integrations must pass semantic provider names,
operation names, reason codes, and opaque identities rather than private data.

The database is not encrypted. Owner-only permissions protect it from ordinary
other local users, but not from another process already running as the same
user or from a compromised operating system. Restoration plaintext remains the
responsibility of the existing session-vault architecture, not lineage.

## Repository API

`openLineageRepository(options?)` returns an append/query repository:

- `await append(event, { signal? })` atomically appends one immutable event and any session, value,
  or placeholder identity created by that event.
- `lookup(eventId)` returns one event or `undefined`.
- `lookupSession(sessionId)`, `lookupValue(valueId)`, and
  `lookupPlaceholder(placeholderId)` inspect identity origins.
- `sessionTraversal(sessionId, { limit? })` returns a session's events ordered by
  occurrence time and insertion order.
- `valueTraversal(valueId, { limit? })` includes direct value references, parent
  value references, and events that reference one of the value's placeholders.
- `causalTraversal(eventId, { limit? })` follows parent events from the root to
  the requested event.
- `iterateChronological({ fromOccurredAt?, toOccurredAt?, limit? })` yields
  events in chronological order; `chronological(options?)` returns the same
  result as an array.
- `close()` is idempotent. Operations after close fail with
  `PRIVACYAI_LINEAGE_CLOSED`.

Returned event objects and metadata are frozen. Repository queries expose domain
identities, not SQLite row identities.

## Transaction and persistence behavior

Each append executes under `BEGIN IMMEDIATE`. Relationship checks, the event
insert, and any session/value/placeholder origin insert commit as one SQLite
transaction. Missing parents, duplicate event/session/value/placeholder
identities, and mismatched placeholder/value references roll back without a
partial event.

SQLite's synchronous operations use only a short per-attempt busy timeout.
Opening and appending retry contention with asynchronous backoff up to the
bounded wall-clock timeout (`lineageRetryTimeoutMs`, default 10 seconds), and
accept `AbortSignal` cancellation. Exhausted contention returns
`PRIVACYAI_LINEAGE_BUSY`; corrupt storage remains distinct.

## Production recorder and inspection

Production request paths accept an optional narrow `lineageRecorder` with
`protectedRequest`, `providerResponse`, and `restoration` methods. Codex and
Antigravity invoke this boundary after protected request creation and around
provider/restore activity; those adapters never import SQLite. Use
`createLineageRecorder(repository)` to connect the durable repository.
For a protected request, the recorder emits one provider request, response, and
restoration event for each assigned placeholder/value relation; events in each
phase share an opaque request, response, or restoration reference. The returned
frozen handle exposes only the opaque request reference. Its private lifecycle
state retains per-relation causal event IDs so concurrent responses and
restorations explicitly parent their matching relation rather than relying on
session event order. Retrying an interrupted protected request in the same
recorder process resumes completed relations without duplicating them.

`openLineageInspection({ lineageDbPath })` opens only an existing database with
SQLite's read-only connection mode. It can observe committed WAL frames from a
live writer, while never creating directories, database files, WAL/SHM
sidecars, schemas, migrations, repairs, or permission changes. Missing state
returns `PRIVACYAI_LINEAGE_NOT_FOUND`; corrupt or incompatible state returns a
stable sanitized lineage error.

The database uses foreign keys, WAL mode, `synchronous=FULL`, a bounded SQLite
busy timeout, and monotonically increasing repository `recordedAt` values.
Concurrent first opens serialize schema creation; concurrent writers serialize
append transactions. Under SQLite and the underlying filesystem's documented
durability guarantees, an interrupted uncommitted transaction is recovered as
absent, while a successfully committed transaction is recovered as committed.
This is not a guarantee against storage hardware that falsely reports durable
writes.

Update and delete triggers reject mutation of events, sessions, values, and
placeholders even through a direct SQL connection. The public repository has no
update, delete, pruning, or retention API. Future retention must be introduced
as an explicit policy and cannot silently rewrite retained history.

## Filesystem and corruption behavior

For the default path, the PrivacyAI storage directory is owner-only (`0700`).
The database and present WAL/SHM sidecars are forced to `0600`. Explicit parent
directory permissions are preserved, but the parent must be owned by the
current user and must not be group- or world-writable.

Opening rejects:

- symlink components or symlink database/sidecar files;
- non-regular files and files with additional hard links;
- files or the immediate storage directory owned by another user;
- path replacement detected while the database is opening.

Schema creation and declared schema checks are explicit. Version 1 introduces
no migration. A lower version returns
`PRIVACYAI_LINEAGE_SCHEMA_MIGRATION_REQUIRED`, a higher version returns
`PRIVACYAI_LINEAGE_SCHEMA_UNSUPPORTED`, malformed SQLite returns
`PRIVACYAI_LINEAGE_CORRUPT`, and missing tables/indexes/immutability triggers
return `PRIVACYAI_LINEAGE_SCHEMA_INVALID`. Existing event metadata is validated
again when read, including deterministic JSON serialization.
