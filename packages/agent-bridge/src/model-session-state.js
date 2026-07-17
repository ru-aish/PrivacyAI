export class KeyedSerialQueue {
  constructor() {
    this.pending = new Map();
  }

  async run(key, operation) {
    const previous = this.pending.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.pending.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.pending.get(key) === tail) this.pending.delete(key);
    }
  }
}

export function sessionVerificationCache(context, sessionKey) {
  let memory = context.sessionCaches.get(sessionKey);
  if (!memory) {
    const maxSessions = positiveInteger(context.maxCachedSessions, 64);
    while (context.sessionCaches.size >= maxSessions) {
      const oldest = context.sessionCaches.keys().next().value;
      if (oldest == null) break;
      context.sessionCaches.delete(oldest);
    }
    memory = new Map();
    context.sessionCaches.set(sessionKey, memory);
  }

  return {
    get(key, policyFingerprint) {
      if (memory.has(key)) {
        const value = memory.get(key);
        memory.delete(key);
        memory.set(key, value);
        return value;
      }
      const persisted = context.verificationStore?.getVerification(key, policyFingerprint);
      if (persisted) memory.set(key, persisted);
      return persisted;
    },
    set(key, value) {
      if (memory.has(key)) memory.delete(key);
      memory.set(key, value);
    },
    delete(key) {
      return memory.delete(key);
    },
    keys() {
      return memory.keys();
    },
    get size() {
      return memory.size;
    }
  };
}

export function commitVerificationWrites(
  cache,
  writes = [],
  options = {}
) {
  const maxEntries = positiveInteger(options.maxEntries, 2048);
  for (const [key, value] of writes) {
    cache.set(key, value);
    options.verificationStore?.putVerification(value);
  }
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function mergeSessionMaps(current, inherited, options = {}) {
  const merged = { ...(current || {}) };
  const maxAliasesPerOriginal = positiveInteger(options.maxAliasesPerOriginal, 1);
  const aliasCounts = new Map();
  for (const original of Object.values(merged)) {
    aliasCounts.set(original, (aliasCounts.get(original) || 0) + 1);
  }

  for (const [placeholder, original] of Object.entries(inherited || {})) {
    if (Object.hasOwn(merged, placeholder)) {
      if (merged[placeholder] !== original) throw collisionError(options, "placeholder");
      continue;
    }
    const aliasCount = aliasCounts.get(original) || 0;
    if (aliasCount >= maxAliasesPerOriginal) throw collisionError(options, "original");
    merged[placeholder] = original;
    aliasCounts.set(original, aliasCount + 1);
  }
  return merged;
}

export function sessionMapsEqual(left, right) {
  const leftEntries = Object.entries(left || {}).sort();
  const rightEntries = Object.entries(right || {}).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function collisionError(options, kind) {
  if (typeof options.collisionError === "function") return options.collisionError(kind);
  const error = new Error(
    kind === "placeholder"
      ? "PrivacyAI blocked an ambiguous placeholder mapping."
      : "PrivacyAI blocked an ambiguous private-value mapping."
  );
  error.code = "PRIVACYAI_SESSION_MAP_COLLISION";
  return error;
}

function positiveInteger(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
