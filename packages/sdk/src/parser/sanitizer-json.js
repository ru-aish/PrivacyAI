export function parseSanitizerJson(text) {
  const json = extractJson(text);
  if (!json || typeof json.safe_prompt !== "string") return null;

  const sessionMap = normalizeSessionMap(json.session_map);
  if (!sessionMap) return null;

  return {
    safe_prompt: json.safe_prompt,
    session_map: sessionMap
  };
}

export function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const sessionMap = {};
  for (const [dummy, original] of Object.entries(value)) {
    if (typeof dummy !== "string" || typeof original !== "string") continue;
    if (!dummy || !original) continue;
    sessionMap[dummy] = original;
  }

  return sessionMap;
}

export function extractJson(text) {
  if (typeof text !== "string") return undefined;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
