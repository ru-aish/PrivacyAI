export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function copyHttpHeaders(input, excludedNames = HOP_BY_HOP_HEADERS, options = {}) {
  const output = {};
  const excludedPrefixes = options.excludedPrefixes || [];
  for (const [name, value] of Object.entries(input || {})) {
    const normalized = name.toLowerCase();
    if (excludedNames.has(normalized)) continue;
    if (excludedPrefixes.some(prefix => normalized.startsWith(prefix))) continue;
    if (value == null && options.includeNull !== true) continue;
    output[options.lowerCaseNames ? normalized : name] = value;
  }
  return output;
}

export function forwardHttpHeaders(response, headers, excludedNames = HOP_BY_HOP_HEADERS) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (excludedNames.has(name.toLowerCase())) continue;
    if (value != null) response.setHeader(name, value);
  }
}
