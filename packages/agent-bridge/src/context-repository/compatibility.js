const legacyUpdateQueues = new Map();

export function updateRepositoryThread(store, sessionKey, updater) {
  if (typeof store?.updateThread === "function") {
    return store.updateThread(sessionKey, updater);
  }
  if (typeof store?.loadThread !== "function" || typeof store?.saveThread !== "function") {
    throw new TypeError("Context verification stores must implement loadThread and saveThread.");
  }
  if (typeof updater !== "function") {
    throw new TypeError("updateRepositoryThread requires a synchronous updater function.");
  }

  return runLegacyUpdate(sessionKey, async () => {
    const current = await store.loadThread(sessionKey);
    const candidate = updater(structuredClone(current));
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || typeof candidate.then === "function") {
      throw new TypeError("updateRepositoryThread updater must return a thread record synchronously.");
    }

    const { baseSessionMap: _baseSessionMap, ...legacyRecord } = candidate;
    return store.saveThread(sessionKey, legacyRecord);
  });
}

async function runLegacyUpdate(sessionKey, operation) {
  const previous = legacyUpdateQueues.get(sessionKey);
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  legacyUpdateQueues.set(sessionKey, turn);

  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (legacyUpdateQueues.get(sessionKey) === turn) legacyUpdateQueues.delete(sessionKey);
  }
}
