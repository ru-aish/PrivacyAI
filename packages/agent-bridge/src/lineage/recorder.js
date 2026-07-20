import { createLineageId } from "./domain.js";

/** Records only public placeholders and aggregate cache activity. */
export function createLineageRecorder(repository) {
  if (!repository || typeof repository.append !== "function") throw new TypeError("Lineage recorder requires an append-capable repository.");
  const sessions = new Map();
  const sessionQueues = new Map();
  const handles = new WeakMap();

  return Object.freeze({
    protectedRequest(request = {}) {
      return serializeSession(sessionQueues, request.sessionKey, async () => {
        const { sessionKey, provider, operation, model, placeholders = [], cacheActivity = {}, signal } = request;
        const state = await stateFor(repository, sessions, sessionKey, signal);
        const relations = [];
        for (const placeholder of uniquePlaceholders(placeholders)) relations.push(await recordPlaceholder(repository, state, placeholder, signal));
        const key = requestKey(provider, operation, model, relations, cacheActivity);
        let lifecycle = state.pendingRequests.get(key);
        if (!lifecycle) {
          lifecycle = createLifecycle(state, key, provider, operation, model, relations, cacheActivity);
          state.pendingRequests.set(key, lifecycle);
        }
        await recordCacheActivity(repository, state, lifecycle, signal);
        state.pendingRequests.delete(key);
        const handle = Object.freeze({ requestRef: lifecycle.requestRef });
        handles.set(handle, lifecycle);
        return handle;
      });
    },
    async providerResponse(handle, { success, signal } = {}) {
      const lifecycle = handles.get(handle);
      if (!lifecycle) return;
      return serializeLifecycle(lifecycle, async () => {
        for (const relation of lifecycle.relations) {
          if (relation.requestEventId) continue;
          const event = await append(repository, lifecycle.state, {
            eventType: "provider_request", ...publicReference(relation.reference), provider: lifecycle.provider,
            operation: lifecycle.operation, model: lifecycle.model, requestRef: lifecycle.requestRef,
            reasonCode: "provider_dispatch", parentEventId: relation.reference.assignmentEventId
          }, signal);
          relation.requestEventId = event.eventId;
        }
        for (const relation of lifecycle.relations) {
          if (relation.responseEventId || !relation.requestEventId) continue;
          const event = await append(repository, lifecycle.state, {
            eventType: "provider_response", ...publicReference(relation.reference), provider: lifecycle.provider,
            requestRef: lifecycle.requestRef, responseRef: lifecycle.responseRef,
            reasonCode: success ? "provider_completion" : "provider_failure", metadata: { success: Boolean(success) },
            parentEventId: relation.requestEventId
          }, signal);
          relation.responseEventId = event.eventId;
        }
      });
    },
    async restoration(handle, { restoredCount = 0, signal } = {}) {
      const lifecycle = handles.get(handle);
      if (!lifecycle) return;
      return serializeLifecycle(lifecycle, async () => {
        if (lifecycle.relations.some(relation => !relation.responseEventId)) return;
        for (const relation of lifecycle.relations) {
          if (relation.restorationEventId) continue;
          const event = await append(repository, lifecycle.state, {
            eventType: "restoration", ...publicReference(relation.reference), restorationRef: lifecycle.restorationRef,
            operation: "response_restore", reasonCode: "local_restoration", metadata: { restoredCount: count(restoredCount) },
            parentEventId: relation.responseEventId
          }, signal);
          relation.restorationEventId = event.eventId;
        }
        if (lifecycle.relations.every(relation => relation.restorationEventId)) handles.delete(handle);
      });
    }
  });
}

function createLifecycle(state, key, provider, operation, model, relations, cacheActivity) {
  return {
    state, key, provider, operation, model, cacheActivity, cacheDone: new Set(),
    requestRef: createLineageId("request"), responseRef: createLineageId("response"), restorationRef: createLineageId("restoration"),
    relations: relations.map(reference => ({ reference, requestEventId: null, responseEventId: null, restorationEventId: null })),
    queue: Promise.resolve()
  };
}

async function stateFor(repository, sessions, token, signal) {
  let state = sessions.get(token);
  if (state) return state;
  state = { sessionId: createLineageId("session"), parentEventId: null, placeholders: new Map(), pendingRequests: new Map() };
  await append(repository, state, { eventType: "session_created", reasonCode: "session_start" }, signal);
  sessions.set(token, state);
  return state;
}
async function recordPlaceholder(repository, state, placeholder, signal) {
  let reference = state.placeholders.get(placeholder);
  if (reference?.assigned) return reference;
  if (!reference) {
    reference = { valueId: createLineageId("value"), placeholderId: createLineageId("placeholder"), assigned: false, assignmentEventId: null };
    await append(repository, state, { eventType: "value_protected", valueId: reference.valueId, transformation: "local_sanitizer", reasonCode: "policy_match" }, signal);
    state.placeholders.set(placeholder, reference);
  }
  const event = await append(repository, state, { eventType: "placeholder_assigned", valueId: reference.valueId, placeholderId: reference.placeholderId, placeholder, reasonCode: "identity_assigned" }, signal);
  reference.assigned = true;
  reference.assignmentEventId = event.eventId;
  return reference;
}
async function recordCacheActivity(repository, state, lifecycle, signal) {
  const reference = lifecycle.relations[0]?.reference;
  if (!reference) return;
  for (const [eventType, amount, reasonCode] of [["cache_hit", lifecycle.cacheActivity.hits, "cache_lookup"], ["cache_miss", lifecycle.cacheActivity.misses, "cache_lookup"], ["cache_write", lifecycle.cacheActivity.writes, "cache_write"]]) {
    if (lifecycle.cacheDone.has(eventType)) continue;
    const itemCount = count(amount);
    if (!itemCount) { lifecycle.cacheDone.add(eventType); continue; }
    await append(repository, state, { eventType, ...publicReference(reference), cacheRef: createLineageId("cache"), operation: eventType === "cache_write" ? "verification_write" : "verification_lookup", reasonCode, metadata: { itemCount } }, signal);
    lifecycle.cacheDone.add(eventType);
  }
}
function requestKey(provider, operation, model, relations, cacheActivity) {
  return JSON.stringify([provider, operation, model, relations.map(relation => relation.placeholderId), count(cacheActivity.hits), count(cacheActivity.misses), count(cacheActivity.writes)]);
}
function publicReference(reference) { return { valueId: reference.valueId, placeholderId: reference.placeholderId }; }
function serializeSession(queues, token, operation) {
  const previous = queues.get(token) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(token, current);
  current.finally(() => { if (queues.get(token) === current) queues.delete(token); }).catch(() => undefined);
  return current;
}
function serializeLifecycle(lifecycle, operation) {
  const current = lifecycle.queue.catch(() => undefined).then(operation);
  lifecycle.queue = current.catch(() => undefined);
  return current;
}
function uniquePlaceholders(value) { return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === "string"))] : []; }
function count(value) { value = Number(value); return Number.isSafeInteger(value) && value > 0 ? value : 0; }
async function append(repository, state, fields, signal) {
  const explicitParent = Object.hasOwn(fields, "parentEventId");
  const event = await repository.append({ eventId: createLineageId("event"), sessionId: state.sessionId, parentEventId: explicitParent ? fields.parentEventId : state.parentEventId, ...fields }, { signal });
  if (!explicitParent) state.parentEventId = event.eventId;
  return event;
}
export async function recordLineage(recorder, method, ...args) { if (!recorder || typeof recorder[method] !== "function") return undefined; return recorder[method](...args); }

/** Records a provider failure without replacing the transport error in flight. */
export async function recordFailedProviderResponse(recorder, handle) {
  try {
    await recordLineage(recorder, "providerResponse", handle, { success: false });
  } catch {
    // Preserve the provider transport failure as the primary error.
  }
}
