import { createLineageId } from "./domain.js";

/** A deliberately small production boundary: callers supply a recorder, never SQLite. */
export function createLineageRecorder(repository) {
  if (!repository || typeof repository.append !== "function") {
    throw new TypeError("Lineage recorder requires an append-capable repository.");
  }
  const sessions = new Map();
  return Object.freeze({
    async protectedRequest({ sessionKey, provider, operation, model, additions = {}, cacheWrites = [], signal }) {
      // sessionKey and original mapping values may be sensitive. They are used
      // only as in-memory map keys; every persisted identity is freshly opaque.
      let state = sessions.get(sessionKey);
      if (!state) {
        state = { sessionId: createLineageId("session"), parentEventId: null, values: new Map(), placeholders: new Map() };
        sessions.set(sessionKey, state);
        await append(repository, state, { eventType: "session_created", reasonCode: "session_start" }, signal);
      }
      for (const placeholder of Object.keys(additions)) {
        let valueId = state.values.get(placeholder);
        if (!valueId) {
          valueId = createLineageId("value");
          state.values.set(placeholder, valueId);
          await append(repository, state, { eventType: "value_protected", valueId, transformation: "local_sanitizer", reasonCode: "policy_match" }, signal);
          const placeholderId = createLineageId("placeholder");
          state.placeholders.set(placeholder, placeholderId);
          await append(repository, state, { eventType: "placeholder_assigned", valueId, placeholderId, placeholder, reasonCode: "identity_assigned" }, signal);
        }
      }
      const valueId = state.values.values().next().value;
      const placeholderId = state.placeholders.values().next().value;
      for (const _write of cacheWrites) {
        await append(repository, state, { eventType: "cache_write", valueId, placeholderId, cacheRef: createLineageId("cache"), operation: "verification_write", reasonCode: "cache_write" }, signal);
      }
      const requestRef = createLineageId("request");
      await append(repository, state, { eventType: "provider_request", valueId, placeholderId, provider, operation, model, requestRef, reasonCode: "provider_dispatch" }, signal);
      return Object.freeze({ sessionKey, requestRef, valueId, placeholderId, provider });
    },
    async providerResponse(handle, { success, signal }) {
      const state = sessions.get(handle?.sessionKey);
      if (!state || (!handle.valueId && !handle.placeholderId)) return;
      await append(repository, state, {
        eventType: "provider_response", valueId: handle.valueId, placeholderId: handle.placeholderId,
        provider: handle.provider, requestRef: handle.requestRef, responseRef: createLineageId("response"), reasonCode: success ? "provider_completion" : "provider_failure",
        metadata: { success: Boolean(success) }
      }, signal);
    },
    async restoration(handle, { restoredCount = 0, signal } = {}) {
      const state = sessions.get(handle?.sessionKey);
      if (!state || (!handle.valueId && !handle.placeholderId)) return;
      await append(repository, state, {
        eventType: "restoration", valueId: handle.valueId, placeholderId: handle.placeholderId,
        restorationRef: createLineageId("restoration"), operation: "response_restore", reasonCode: "local_restoration",
        metadata: { restoredCount: Number(restoredCount) || 0 }
      }, signal);
    }
  });
}

async function append(repository, state, fields, signal) {
  const event = await repository.append({
    eventId: createLineageId("event"), sessionId: state.sessionId, parentEventId: state.parentEventId,
    ...fields
  }, { signal });
  state.parentEventId = event.eventId;
  return event;
}

export async function recordLineage(recorder, method, ...args) {
  if (!recorder || typeof recorder[method] !== "function") return undefined;
  return recorder[method](...args);
}
