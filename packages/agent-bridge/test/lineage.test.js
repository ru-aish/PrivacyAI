import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LINEAGE_SCHEMA_VERSION,
  createLineageId,
  normalizeEvent,
  normalizeMetadata,
  openLineageRepository,
  openLineageInspection,
  createLineageRecorder,
  stableJson
} from "../src/lineage/index.js";

const childFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "lineage-child.js"
);
const opaque = (namespace, character) => `${namespace}:${character.repeat(32)}`;
const ids = Object.freeze({
  session: opaque("session", "a"),
  session2: opaque("session", "b"),
  value: opaque("value", "c"),
  value2: opaque("value", "d"),
  placeholder: opaque("placeholder", "e"),
  placeholder2: opaque("placeholder", "f"),
  policy: opaque("policy", "1"),
  transformation: opaque("transformation", "2"),
  request: opaque("request", "3"),
  response: opaque("response", "4"),
  restoration: opaque("restoration", "5"),
  cache: opaque("cache", "6")
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-"));
  await chmod(root, 0o700);
  const path = join(root, "lineage.sqlite3");
  const repository = await openLineageRepository({ lineageDbPath: path, ...options });
  t.after(async () => {
    repository.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, path, repository };
}

function eventId(character) {
  return opaque("event", character);
}

function sessionEvent(extra = {}) {
  return {
    eventId: eventId("a"),
    sessionId: ids.session,
    eventType: "session_created",
    occurredAt: 10,
    reasonCode: "session_start",
    ...extra
  };
}

function protectEvent(extra = {}) {
  return {
    eventId: eventId("b"),
    sessionId: ids.session,
    eventType: "value_protected",
    occurredAt: 20,
    parentEventId: eventId("a"),
    valueId: ids.value,
    policyRef: ids.policy,
    transformation: "local_sanitizer",
    reasonCode: "policy_match",
    ...extra
  };
}

function assignEvent(extra = {}) {
  return {
    eventId: eventId("c"),
    sessionId: ids.session,
    eventType: "placeholder_assigned",
    occurredAt: 30,
    parentEventId: eventId("b"),
    valueId: ids.value,
    placeholderId: ids.placeholder,
    placeholder: "[EMAIL_1]",
    reasonCode: "identity_assigned",
    ...extra
  };
}

async function seed(repository) {
  const session = await repository.append(sessionEvent());
  const value = await repository.append(protectEvent());
  const placeholder = await repository.append(assignEvent());
  return { session, value, placeholder };
}

test("records a complete immutable lineage and traverses it by session, value, cause, and time", async t => {
  let clock = 1_000;
  const { repository } = await fixture(t, { clock: () => clock++ });
  const { session, value, placeholder } = await seed(repository);

  const transformation = await repository.append({
    eventId: eventId("d"),
    sessionId: ids.session,
    eventType: "transformation",
    occurredAt: 40,
    parentEventId: placeholder.eventId,
    valueId: ids.value,
    placeholderId: ids.placeholder,
    transformation: "structured_redaction",
    transformationRef: ids.transformation,
    policyRef: ids.policy,
    artifactType: "text",
    reasonCode: "policy_application",
    metadata: { itemCount: 1, success: true }
  });
  const cacheMiss = await repository.append({
    eventId: eventId("e"),
    sessionId: ids.session,
    eventType: "cache_miss",
    occurredAt: 50,
    parentEventId: transformation.eventId,
    valueId: ids.value,
    cacheRef: ids.cache,
    operation: "verification_lookup",
    reasonCode: "cache_lookup",
    metadata: { cacheHit: false }
  });
  const request = await repository.append({
    eventId: eventId("f"),
    sessionId: ids.session,
    eventType: "provider_request",
    occurredAt: 60,
    parentEventId: cacheMiss.eventId,
    valueId: ids.value,
    placeholderId: ids.placeholder,
    provider: "openai",
    operation: "responses.create",
    model: "gpt-5.6",
    requestRef: ids.request,
    reasonCode: "provider_dispatch",
    metadata: { attempt: 1, streaming: true }
  });
  const response = await repository.append({
    eventId: eventId("1"),
    sessionId: ids.session,
    eventType: "provider_response",
    occurredAt: 70,
    parentEventId: request.eventId,
    valueId: ids.value,
    placeholderId: ids.placeholder,
    provider: "openai",
    requestRef: ids.request,
    responseRef: ids.response,
    reasonCode: "provider_completion",
    metadata: { success: true }
  });
  const restoration = await repository.append({
    eventId: eventId("2"),
    sessionId: ids.session,
    eventType: "restoration",
    occurredAt: 80,
    parentEventId: response.eventId,
    placeholderId: ids.placeholder,
    restorationRef: ids.restoration,
    operation: "stream_restore",
    reasonCode: "local_restoration",
    metadata: { restoredCount: 1 }
  });

  assert.deepEqual(
    repository.chronological().map(event => event.eventId),
    [session, value, placeholder, transformation, cacheMiss, request, response, restoration]
      .map(event => event.eventId)
  );
  assert.deepEqual(
    [...repository.iterateChronological({ fromOccurredAt: 30, toOccurredAt: 50 })]
      .map(event => event.eventId),
    [placeholder.eventId, transformation.eventId, cacheMiss.eventId]
  );
  assert.deepEqual(
    repository.sessionTraversal(ids.session).map(event => event.eventId),
    repository.chronological().map(event => event.eventId)
  );
  assert.deepEqual(
    repository.valueTraversal(ids.value).map(event => event.eventId),
    [
      value.eventId,
      placeholder.eventId,
      transformation.eventId,
      cacheMiss.eventId,
      request.eventId,
      response.eventId,
      restoration.eventId
    ]
  );
  assert.deepEqual(
    repository.causalTraversal(restoration.eventId).map(event => event.eventId),
    repository.chronological().map(event => event.eventId)
  );

  assert.deepEqual(repository.lookupSession(ids.session), {
    sessionId: ids.session,
    createdEventId: session.eventId,
    createdAt: session.recordedAt
  });
  assert.deepEqual(repository.lookupPlaceholder(ids.placeholder), {
    placeholderId: ids.placeholder,
    sessionId: ids.session,
    valueId: ids.value,
    assignedEventId: placeholder.eventId,
    placeholder: "[EMAIL_1]",
    createdAt: placeholder.recordedAt
  });
  const protectedValue = repository.lookupValue(ids.value);
  assert.equal(protectedValue.sessionId, ids.session);
  assert.equal(protectedValue.createdEventId, value.eventId);
  assert.deepEqual(protectedValue.placeholders, [repository.lookupPlaceholder(ids.placeholder)]);
  assert.equal(repository.lookup(eventId("9")), undefined);
  assert.equal(repository.lookupValue(ids.value2), undefined);
  assert.deepEqual(repository.causalTraversal(eventId("9")), []);
  assert.equal(restoration.schemaVersion, LINEAGE_SCHEMA_VERSION);
  assert.equal(Object.isFrozen(restoration), true);
  assert.equal(Object.isFrozen(restoration.metadata), true);
  assert.equal(response.recordedAt > request.recordedAt, true);
});

test("enforces unique origins, parent references, and atomic append validation", async t => {
  const { repository } = await fixture(t);
  await seed(repository);

  const failures = [
    [{ ...sessionEvent(), eventId: eventId("d") }, "PRIVACYAI_LINEAGE_DUPLICATE_SESSION"],
    [{ ...protectEvent(), eventId: eventId("d") }, "PRIVACYAI_LINEAGE_DUPLICATE_VALUE"],
    [{ ...assignEvent(), eventId: eventId("d") }, "PRIVACYAI_LINEAGE_DUPLICATE_PLACEHOLDER"],
    [{
      eventId: eventId("d"),
      sessionId: ids.session,
      eventType: "cache_write",
      occurredAt: 40,
      parentEventId: eventId("9"),
      cacheRef: ids.cache,
      operation: "write",
      reasonCode: "cache_write"
    }, "PRIVACYAI_LINEAGE_INVALID_PARENT"],
    [{
      eventId: eventId("d"),
      sessionId: ids.session,
      eventType: "value_derived",
      occurredAt: 40,
      parentEventId: eventId("c"),
      parentValueId: ids.value2,
      valueId: opaque("value", "7"),
      transformation: "derived_alias",
      reasonCode: "derived_value"
    }, "PRIVACYAI_LINEAGE_INVALID_PARENT"],
    [{
      eventId: eventId("d"),
      sessionId: ids.session2,
      eventType: "cache_miss",
      occurredAt: 40,
      parentEventId: eventId("c"),
      cacheRef: ids.cache,
      operation: "lookup",
      reasonCode: "cache_lookup"
    }, "PRIVACYAI_LINEAGE_MISSING_SESSION"],
    [{
      eventId: eventId("d"),
      sessionId: ids.session,
      eventType: "transformation",
      occurredAt: 40,
      parentEventId: eventId("c"),
      valueId: ids.value2,
      transformation: "redaction",
      reasonCode: "policy_application"
    }, "PRIVACYAI_LINEAGE_MISSING_VALUE"],
    [{
      eventId: eventId("d"),
      sessionId: ids.session,
      eventType: "restoration",
      occurredAt: 40,
      parentEventId: eventId("c"),
      placeholderId: ids.placeholder2,
      restorationRef: ids.restoration,
      reasonCode: "local_restoration"
    }, "PRIVACYAI_LINEAGE_MISSING_PLACEHOLDER"]
  ];

  for (const [candidate, code] of failures) {
    await assert.rejects(() => repository.append(candidate), error => error?.code === code);
    assert.equal(repository.lookup(candidate.eventId), undefined);
  }

  await assert.rejects(
    () => repository.append(assignEvent()),
    error => error?.code === "PRIVACYAI_LINEAGE_DUPLICATE_EVENT"
  );

  const secondValue = await repository.append({
    eventId: eventId("d"),
    sessionId: ids.session,
    eventType: "value_protected",
    occurredAt: 40,
    parentEventId: eventId("c"),
    valueId: ids.value2,
    policyRef: ids.policy,
    reasonCode: "policy_match"
  });
  await assert.rejects(() => repository.append({
    eventId: eventId("e"),
    sessionId: ids.session,
    eventType: "restoration",
    occurredAt: 50,
    parentEventId: secondValue.eventId,
    valueId: ids.value2,
    placeholderId: ids.placeholder,
    restorationRef: ids.restoration,
    reasonCode: "local_restoration"
  }), error => error?.code === "PRIVACYAI_LINEAGE_PLACEHOLDER_VALUE_MISMATCH");
  assert.equal(repository.lookup(eventId("e")), undefined);
});

test("rejects arbitrary text fields and serializes safe diagnostics deterministically", async t => {
  const { path, repository } = await fixture(t);
  const secret = "raw-secret-fixture-DO-NOT-PERSIST";

  await assert.rejects(
    () => repository.append({ ...sessionEvent(), rawPrompt: secret }),
    error => error?.code === "PRIVACYAI_LINEAGE_INVALID_EVENT"
  );
  await assert.rejects(
    () => repository.append({ ...sessionEvent(), sessionId: `session:${secret}` }),
    error => error?.code === "PRIVACYAI_LINEAGE_INVALID_EVENT"
  );
  assert.throws(
    () => normalizeMetadata({ diagnostic: secret }),
    error => error?.code === "PRIVACYAI_LINEAGE_INVALID_EVENT"
  );
  assert.throws(
    () => normalizeEvent({ ...sessionEvent(), reasonCode: secret }),
    error => error?.code === "PRIVACYAI_LINEAGE_INVALID_EVENT"
  );

  const normalized = normalizeEvent({
    ...sessionEvent(),
    metadata: { success: true, attempt: 2 }
  }, { recordedAt: 100 });
  assert.deepEqual(normalized.metadata, { attempt: 2, success: true });
  assert.equal(stableJson({ z: 1, a: undefined, b: [1, undefined] }), '{"b":[1,null],"z":1}');

  await repository.append(sessionEvent({ metadata: { success: true, attempt: 2 } }));
  repository.close();
  const bytes = Buffer.concat([
    await readFile(path),
    await readFile(`${path}-wal`).catch(() => Buffer.alloc(0)),
    await readFile(`${path}-shm`).catch(() => Buffer.alloc(0))
  ]);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test("SQLite tables and repository APIs prevent historical mutation or deletion", async t => {
  const { repository } = await fixture(t);
  await seed(repository);

  assert.throws(
    () => repository.database.prepare(
      "UPDATE lineage_events SET reason_code = 'rewritten' WHERE event_id = ?"
    ).run(eventId("b")),
    /immutable/
  );
  assert.throws(
    () => repository.database.prepare(
      "DELETE FROM lineage_values WHERE value_id = ?"
    ).run(ids.value),
    /immutable/
  );
  assert.equal(repository.lookup(eventId("b")).reasonCode, "policy_match");
  assert.equal(repository.lookupValue(ids.value).valueId, ids.value);

  repository.close();
  assert.throws(
    () => repository.lookup(eventId("b")),
    error => error?.code === "PRIVACYAI_LINEAGE_CLOSED"
  );
  await assert.rejects(
    () => repository.append(sessionEvent()),
    error => error?.code === "PRIVACYAI_LINEAGE_CLOSED"
  );
});

test("schema mismatch, unsupported versions, malformed files, and corrupted rows fail explicitly", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-corruption-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const malformedPath = join(root, "malformed.sqlite3");
  await writeFile(malformedPath, "not sqlite", { mode: 0o600 });
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: malformedPath }),
    error => error?.code === "PRIVACYAI_LINEAGE_CORRUPT"
  );

  const { DatabaseSync } = await import("node:sqlite");
  const unknownPath = join(root, "unknown.sqlite3");
  const unknown = new DatabaseSync(unknownPath);
  unknown.exec("CREATE TABLE unrelated(value TEXT)");
  unknown.close();
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: unknownPath }),
    error => error?.code === "PRIVACYAI_LINEAGE_SCHEMA_INVALID"
  );

  const versionPath = join(root, "version.sqlite3");
  let repository = await openLineageRepository({ lineageDbPath: versionPath });
  repository.close();
  let database = new DatabaseSync(versionPath);
  database.prepare(
    "UPDATE privacyai_lineage_meta SET value = '0' WHERE key = 'schema_version'"
  ).run();
  database.close();
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: versionPath }),
    error => error?.code === "PRIVACYAI_LINEAGE_SCHEMA_MIGRATION_REQUIRED"
  );
  database = new DatabaseSync(versionPath);
  database.prepare(
    "UPDATE privacyai_lineage_meta SET value = '999' WHERE key = 'schema_version'"
  ).run();
  database.close();
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: versionPath }),
    error => error?.code === "PRIVACYAI_LINEAGE_SCHEMA_UNSUPPORTED"
  );

  const corruptRowPath = join(root, "row.sqlite3");
  repository = await openLineageRepository({ lineageDbPath: corruptRowPath });
  await repository.append(sessionEvent());
  repository.database.exec("DROP TRIGGER lineage_events_no_update");
  repository.database.prepare(
    "UPDATE lineage_events SET metadata_json = ? WHERE event_id = ?"
  ).run('{"success": true}', eventId("a"));
  assert.throws(
    () => repository.lookup(eventId("a")),
    error => error?.code === "PRIVACYAI_LINEAGE_CORRUPT"
  );
  repository.close();
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: corruptRowPath }),
    error => error?.code === "PRIVACYAI_LINEAGE_SCHEMA_INVALID"
  );
});

test("multiple processes can initialize the same new database safely", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-initialize-"));
  await chmod(root, 0o700);
  const path = join(root, "lineage.sqlite3");
  t.after(() => rm(root, { recursive: true, force: true }));

  const output = await Promise.all(
    Array.from({ length: 6 }, () => runChild(["open", path]))
  );
  assert.deepEqual(output, Array.from({ length: 6 }, () => "ok"));

  const repository = await openLineageRepository({ lineageDbPath: path });
  assert.deepEqual(repository.chronological(), []);
  repository.close();
});

test("multiple processes append concurrently without losing events", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-concurrent-"));
  await chmod(root, 0o700);
  const path = join(root, "lineage.sqlite3");
  t.after(() => rm(root, { recursive: true, force: true }));

  let repository = await openLineageRepository({ lineageDbPath: path });
  const parent = await repository.append(sessionEvent());
  repository.close();

  const jobs = Array.from({ length: 8 }, (_, index) => runChild([
    "append",
    path,
    ids.session,
    opaque("event", String(index + 1)),
    opaque("cache", String(index + 1)),
    parent.eventId
  ]));
  const output = await Promise.all(jobs);
  assert.deepEqual(output, Array.from({ length: 8 }, () => "ok"));

  repository = await openLineageRepository({ lineageDbPath: path });
  assert.equal(repository.chronological().length, 9);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(repository.lookup(opaque("event", String(index + 1))).eventType, "cache_miss");
  }
  repository.close();
});

test("an interrupted uncommitted write is absent after recovery and later appends remain usable", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-interrupt-"));
  await chmod(root, 0o700);
  const path = join(root, "lineage.sqlite3");
  t.after(() => rm(root, { recursive: true, force: true }));

  let repository = await openLineageRepository({ lineageDbPath: path });
  const parent = await repository.append(sessionEvent());
  repository.close();

  const interruptedEventId = opaque("event", "7");
  const child = spawn(process.execPath, [
    childFixture,
    "interrupt",
    path,
    ids.session,
    interruptedEventId,
    opaque("cache", "7"),
    parent.eventId
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForLine(child, "ready");
  child.kill("SIGKILL");
  await waitForExit(child);

  repository = await openLineageRepository({ lineageDbPath: path });
  assert.equal(repository.lookup(interruptedEventId), undefined);
  const committed = await repository.append({
    eventId: opaque("event", "8"),
    sessionId: ids.session,
    eventType: "cache_write",
    occurredAt: 30,
    parentEventId: parent.eventId,
    cacheRef: opaque("cache", "8"),
    operation: "write",
    reasonCode: "cache_write"
  });
  assert.equal(repository.lookup(committed.eventId).eventType, "cache_write");
  repository.close();
});

test("storage permissions are private while explicit safe parent permissions are preserved", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-permissions-"));
  await chmod(root, 0o700);
  const parent = join(root, "shared-parent");
  await mkdir(parent, { mode: 0o755 });
  await chmod(parent, 0o755);
  const path = join(parent, "lineage.sqlite3");
  t.after(() => rm(root, { recursive: true, force: true }));

  const repository = await openLineageRepository({ lineageDbPath: path });
  await repository.append(sessionEvent());
  repository.close();

  assert.equal((await stat(parent)).mode & 0o777, 0o755);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const wal = await stat(`${path}-wal`).catch(() => undefined);
  if (wal) assert.equal(wal.mode & 0o777, 0o600);
});

test("rejects symlink, hard-link, and writable-parent storage attacks", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-lineage-paths-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const real = join(root, "real");
  await mkdir(real, { mode: 0o700 });
  const linkedParent = join(root, "linked-parent");
  await symlink(real, linkedParent);
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: join(linkedParent, "lineage.sqlite3") }),
    error => error?.code === "PRIVACYAI_LINEAGE_UNSAFE_PATH"
  );

  const target = join(root, "target.sqlite3");
  await writeFile(target, "target", { mode: 0o600 });
  const finalLink = join(root, "final-link.sqlite3");
  await symlink(target, finalLink);
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: finalLink }),
    error => error?.code === "PRIVACYAI_LINEAGE_UNSAFE_PATH"
  );

  const hardLink = join(root, "hard-link.sqlite3");
  await link(target, hardLink);
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: hardLink }),
    error => error?.code === "PRIVACYAI_LINEAGE_UNSAFE_PATH"
  );

  const sidecarPath = join(real, "sidecar.sqlite3");
  await symlink(target, `${sidecarPath}-wal`);
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: sidecarPath }),
    error => error?.code === "PRIVACYAI_LINEAGE_UNSAFE_PATH"
  );

  const writable = join(root, "writable");
  await mkdir(writable, { mode: 0o700 });
  await chmod(writable, 0o777);
  await assert.rejects(
    () => openLineageRepository({ lineageDbPath: join(writable, "lineage.sqlite3") }),
    error => error?.code === "PRIVACYAI_LINEAGE_UNSAFE_PATH"
  );
});

test("public exports expose the lineage contract without exposing database row identities", async () => {
  const publicApi = await import("../src/index.js");
  assert.equal(publicApi.openLineageRepository, openLineageRepository);
  assert.equal(publicApi.LINEAGE_SCHEMA_VERSION, LINEAGE_SCHEMA_VERSION);
  const generated = createLineageId("event");
  assert.match(generated, /^event:[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(normalizeEvent(sessionEvent()), "rowId"), false);
});

test("read-only inspection never creates or mutates lineage state", async t => {
  const { path, repository } = await fixture(t);
  await seed(repository);
  repository.close();
  const before = await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async candidate => {
    try { const info = await stat(candidate); return [candidate, info.size, info.mtimeMs]; } catch { return [candidate, null]; }
  }));
  const inspection = await openLineageInspection({ lineageDbPath: path });
  assert.equal(inspection.chronological().length, 3);
  assert.throws(() => inspection.database.exec("INSERT INTO lineage_events DEFAULT VALUES"));
  inspection.close();
  const after = await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async candidate => {
    try { const info = await stat(candidate); return [candidate, info.size, info.mtimeMs]; } catch { return [candidate, null]; }
  }));
  assert.deepEqual(after, before);
  await assert.rejects(
    () => openLineageInspection({ lineageDbPath: join(dirname(path), "missing.sqlite3") }),
    error => error?.code === "PRIVACYAI_LINEAGE_NOT_FOUND"
  );
});

test("recorder persists only opaque lifecycle references for protected provider traffic", async t => {
  const { path, repository } = await fixture(t);
  const recorder = createLineageRecorder(repository);
  const secret = "raw-value-must-never-reach-lineage";
  const handle = await recorder.protectedRequest({
    sessionKey: "in-memory-session", provider: "codex", operation: "responses.create", model: "gpt-5",
    placeholders: ["[EMAIL_1]"], cacheActivity: { writes: 1 }
  });
  await recorder.providerResponse(handle, { success: true });
  await recorder.restoration(handle, { restoredCount: 1 });
  assert.deepEqual(repository.chronological().map(event => event.eventType), [
    "session_created", "value_protected", "placeholder_assigned", "cache_write", "provider_request", "provider_response", "restoration"
  ]);
  repository.close();
  const bytes = await readFile(path);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
});

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFixture, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`lineage child exited ${code}: ${stderr}`));
    });
  });
}

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error("lineage child did not become ready")), 10_000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.split(/\r?\n/).includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      if (!stdout.split(/\r?\n/).includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`lineage child exited ${code}: ${stderr}`));
      }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => child.once("close", resolve));
}
