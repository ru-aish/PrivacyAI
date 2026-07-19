export function createLegacyVerificationStore() {
  const records = new Map();
  const threads = new Map();
  const store = {
    loadThread(key) {
      return structuredClone(threads.get(key) || {
        sessionKey: key,
        parentSessionKeys: [],
        sessionMap: {},
        policyFingerprint: "",
        updatedAt: 0
      });
    },
    saveThread(key, value) {
      const saved = { ...structuredClone(value), sessionKey: key };
      threads.set(key, saved);
      return saved;
    },
    getVerification(key, policyFingerprint) {
      const value = records.get(key);
      return value?.policyFingerprint === policyFingerprint ? structuredClone(value) : undefined;
    },
    putVerification(value) {
      records.set(value.cacheKey, structuredClone(value));
    },
    recordThreadItem() {},
    prune() {},
    close() {}
  };
  return { records, store, threads };
}
