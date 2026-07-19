import { openLineageRepository } from "../../src/lineage/index.js";

const [mode, path, sessionId, eventId, referenceId, parentEventId] = process.argv.slice(2);
const repository = await openLineageRepository({ lineageDbPath: path });

if (mode === "open") {
  repository.close();
  process.stdout.write("ok\n");
  process.exit(0);
}

if (mode === "append") {
  repository.append({
    eventId,
    sessionId,
    eventType: "cache_miss",
    occurredAt: Date.now(),
    parentEventId,
    cacheRef: referenceId,
    operation: "lookup",
    reasonCode: "cache_lookup"
  });
  repository.close();
  process.stdout.write("ok\n");
  process.exit(0);
}

if (mode === "interrupt") {
  const recordedAt = Math.max(
    Date.now(),
    Number(repository.database.prepare(
      "SELECT recorded_at FROM lineage_events ORDER BY recorded_at DESC LIMIT 1"
    ).get()?.recorded_at || 0) + 1
  );
  repository.database.exec("BEGIN IMMEDIATE");
  repository.database.prepare(`
    INSERT INTO lineage_events(
      event_id, schema_version, session_id, event_type, occurred_at, recorded_at,
      parent_event_id, parent_value_id, value_id, placeholder_id,
      provider, operation, model, artifact_type, phase, policy_ref,
      transformation, transformation_ref, request_ref, response_ref,
      restoration_ref, cache_ref, reason_code, diagnostic_code, metadata_json
    ) VALUES (
      ?, 1, ?, 'cache_write', ?, ?,
      ?, NULL, NULL, NULL,
      NULL, 'write', NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      NULL, ?, 'cache_write', NULL, '{}'
    )
  `).run(eventId, sessionId, Date.now(), recordedAt, parentEventId, referenceId);
  process.stdout.write("ready\n");
  setInterval(() => {}, 1_000);
} else {
  repository.close();
  throw new Error("unknown lineage child mode");
}
