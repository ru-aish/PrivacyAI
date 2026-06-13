export function getFetch(customFetch) {
  if (customFetch) {
    return customFetch;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  return null;
}