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

function extractJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
  ];

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}
