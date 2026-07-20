import { createLineageId } from "./domain.js";

/** Records only public placeholders and aggregate cache activity. */
export function createLineageRecorder(repository) {
  if (!repository || typeof repository.append !== "function") throw new TypeError("Lineage recorder requires an append-capable repository.");
  const sessions = new Map();
  return Object.freeze({
    async protectedRequest({ sessionKey, provider, operation, model, placeholders = [], cacheActivity = {}, signal }) {
      const state = await stateFor(repository, sessions, sessionKey, signal);
      for (const placeholder of uniquePlaceholders(placeholders)) await recordPlaceholder(repository, state, placeholder, signal);
      const reference = firstReference(state);
      await recordCacheActivity(repository, state, reference, cacheActivity, signal);
      const requestRef = createLineageId("request");
      await append(repository, state, { eventType: "provider_request", ...reference, provider, operation, model, requestRef, reasonCode: "provider_dispatch" }, signal);
      return Object.freeze({ sessionToken: sessionKey, requestRef, ...reference, provider });
    },
    async providerResponse(handle, { success, signal } = {}) {
      const state = sessions.get(handle?.sessionToken);
      if (!state || !handle?.valueId || !handle?.placeholderId) return;
      await append(repository, state, { eventType: "provider_response", valueId: handle.valueId, placeholderId: handle.placeholderId, provider: handle.provider, requestRef: handle.requestRef, responseRef: createLineageId("response"), reasonCode: success ? "provider_completion" : "provider_failure", metadata: { success: Boolean(success) } }, signal);
    },
    async restoration(handle, { restoredCount = 0, signal } = {}) {
      const state = sessions.get(handle?.sessionToken);
      if (!state || !handle?.valueId || !handle?.placeholderId) return;
      await append(repository, state, { eventType: "restoration", valueId: handle.valueId, placeholderId: handle.placeholderId, restorationRef: createLineageId("restoration"), operation: "response_restore", reasonCode: "local_restoration", metadata: { restoredCount: count(restoredCount) } }, signal);
    }
  });
}

async function stateFor(repository, sessions, token, signal) {
  let state = sessions.get(token);
  if (state) return state;
  state = { sessionId: createLineageId("session"), parentEventId: null, placeholders: new Map() };
  sessions.set(token, state);
  await append(repository, state, { eventType: "session_created", reasonCode: "session_start" }, signal);
  return state;
}
async function recordPlaceholder(repository, state, placeholder, signal) {
  if (state.placeholders.has(placeholder)) return;
  const valueId = createLineageId("value");
  const placeholderId = createLineageId("placeholder");
  state.placeholders.set(placeholder, { valueId, placeholderId });
  await append(repository, state, { eventType: "value_protected", valueId, transformation: "local_sanitizer", reasonCode: "policy_match" }, signal);
  await append(repository, state, { eventType: "placeholder_assigned", valueId, placeholderId, placeholder, reasonCode: "identity_assigned" }, signal);
}
async function recordCacheActivity(repository, state, reference, activity, signal) {
  for (const [eventType, amount, reasonCode] of [["cache_hit", activity.hits, "cache_lookup"], ["cache_miss", activity.misses, "cache_lookup"], ["cache_write", activity.writes, "cache_write"]]) {
    const itemCount = count(amount);
    if (!itemCount || !reference.valueId) continue;
    await append(repository, state, { eventType, ...reference, cacheRef: createLineageId("cache"), operation: eventType === "cache_write" ? "verification_write" : "verification_lookup", reasonCode, metadata: { itemCount } }, signal);
  }
}
function firstReference(state) { return state.placeholders.values().next().value || {}; }
function uniquePlaceholders(value) { return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === "string"))] : []; }
function count(value) { value = Number(value); return Number.isSafeInteger(value) && value > 0 ? value : 0; }
async function append(repository, state, fields, signal) { const event = await repository.append({ eventId: createLineageId("event"), sessionId: state.sessionId, parentEventId: state.parentEventId, ...fields }, { signal }); state.parentEventId = event.eventId; return event; }
export async function recordLineage(recorder, method, ...args) { if (!recorder || typeof recorder[method] !== "function") return undefined; return recorder[method](...args); }
