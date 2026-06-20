const URL_REGEX = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"']+/gi;
const FILE_PATH_REGEX = /(?:^|\s)((?:\/[A-Za-z0-9._-]+)+(?:\/[A-Za-z0-9._-]+)?)/g;
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const BACKTICK_REGEX = /`[^`]+`/g;
const CONNECTION_STRING_REGEX = /\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|kafka|https?):\/\/\S+/gi;

export function extractProtectedSpans(text) {
  const spans = [];

  for (const match of text.matchAll(URL_REGEX)) {
    spans.push({
      type: "URL",
      start: match.index,
      end: match.index + match[0].length,
      value: match[0]
    });
  }

  for (const match of text.matchAll(CONNECTION_STRING_REGEX)) {
    const existing = spans.find(s => s.start <= match.index && s.end >= match.index + match[0].length);
    if (!existing) {
      spans.push({
        type: "CONNECTION_STRING",
        start: match.index,
        end: match.index + match[0].length,
        value: match[0]
      });
    }
  }

  for (const match of text.matchAll(FILE_PATH_REGEX)) {
    const path = match[1];
    if (path.length < 5) continue;
    if (/\/\/|@|\.com|\.org/.test(path)) continue;
    const existing = spans.find(s => s.start <= match.index && s.end >= match.index + path.length);
    if (!existing) {
      spans.push({
        type: "FILE_PATH",
        start: match.index + match[0].indexOf(path),
        end: match.index + match[0].indexOf(path) + path.length,
        value: path
      });
    }
  }

  for (const match of text.matchAll(CODE_BLOCK_REGEX)) {
    spans.push({
      type: "CODE_BLOCK",
      start: match.index,
      end: match.index + match[0].length,
      value: match[0]
    });
  }

  for (const match of text.matchAll(BACKTICK_REGEX)) {
    const existing = spans.find(s => s.start <= match.index && s.end >= match.index + match[0].length);
    if (!existing) {
      spans.push({
        type: "INLINE_CODE",
        start: match.index,
        end: match.index + match[0].length,
        value: match[0]
      });
    }
  }

  return spans.sort((a, b) => a.start - b.start);
}

export function findProtectedSpan(spans, start, end) {
  return spans.find(s => s.start <= start && s.end >= end);
}

export function isInsideProtectedSpan(spans, start, end) {
  return spans.some(s => s.start <= start && s.end >= end);
}

export function findRedactableSubspans(span, text) {
  if (span.type === "URL" || span.type === "CONNECTION_STRING") {
    return extractUrlCredentials(span.value, span.start);
  }
  return [];
}

const URL_CREDENTIAL_REGEX = /(?:https?:\/\/|ftp:\/\/)([^:]+):([^@]+)@/g;
const URL_QUERY_SECRET_REGEX = /([?&])(token|access_token|api_key|signature|password|secret|sig)=([^&\s"]+)/gi;
const USERINFO_REGEX = /\/\/([^:]+):([^@]+)@/;

function extractUrlCredentials(url, offset) {
  const subspans = [];

  for (const match of url.matchAll(URL_CREDENTIAL_REGEX)) {
    if (match[2]) {
      subspans.push({
        type: "URL_CREDENTIAL",
        start: offset + match.index + match[0].indexOf(match[2]),
        end: offset + match.index + match[0].indexOf(match[2]) + match[2].length,
        value: match[2],
        action: "redact"
      });
    }
  }

  for (const match of url.matchAll(URL_QUERY_SECRET_REGEX)) {
    subspans.push({
      type: "URL_QUERY_SECRET",
      start: offset + match.index + match[0].indexOf(match[3]),
      end: offset + match.index + match[0].indexOf(match[3]) + match[3].length,
      value: match[3],
      action: "redact"
    });
  }

  return subspans;
}
