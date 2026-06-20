export function collectProtectedSpans(text) {
  const spans = [];

  // 1. Code fences
  const codeFenceRegex = /```[\s\S]*?```/g;
  for (const match of text.matchAll(codeFenceRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "code-fence",
      value: match[0]
    });
  }

  // 2. Inline backticks
  const inlineBacktickRegex = /`[^`\n]+`/g;
  for (const match of text.matchAll(inlineBacktickRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "inline-backtick",
      value: match[0]
    });
  }

  // 3. URLs
  const urlRegex = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"']+/gi;
  for (const match of text.matchAll(urlRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "url",
      value: match[0]
    });
  }

  // 4. File paths
  const unixPathRegex = /\b\/?(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\b/g;
  for (const match of text.matchAll(unixPathRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "file-path",
      value: match[0]
    });
  }
  const winPathRegex = /\b[a-zA-Z]:\\[a-zA-Z0-9_-]+(?:\\[a-zA-Z0-9_.-]+)+\b/g;
  for (const match of text.matchAll(winPathRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "file-path",
      value: match[0]
    });
  }

  // 5. Stack trace lines
  const stackTraceRegex = /\bat\s+\S+:\d+:\d+/g;
  for (const match of text.matchAll(stackTraceRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "stack-trace",
      value: match[0]
    });
  }
  const stackTraceParensRegex = /\bat\s+.*?\(\S+:\d+:\d+\)/g;
  for (const match of text.matchAll(stackTraceParensRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "stack-trace",
      value: match[0]
    });
  }

  // 6. Endpoint paths like /api/auth/callback
  const endpointRegex = /\b\/(?:api|v\d+)\/[a-zA-Z0-9_/.-]+\b/g;
  for (const match of text.matchAll(endpointRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "endpoint",
      value: match[0]
    });
  }

  // 7. Scoped packages
  const scopedPkgRegex = /\b@[a-z0-9-]+\/[a-z0-9-]+/gi;
  for (const match of text.matchAll(scopedPkgRegex)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: "package-name",
      value: match[0]
    });
  }

  return mergeProtectedSpans(spans);
}

function mergeProtectedSpans(spans) {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const last = merged[merged.length - 1];

    if (next.start >= last.end) {
      merged.push(next);
    } else {
      if (next.end > last.end) {
        last.end = next.end;
        last.value = last.value + next.value.substring(last.end - next.start);
      }
    }
  }

  return merged;
}

export function isInsideProtectedSpan(start, end, protectedSpans, options = {}) {
  return protectedSpans.some((span) => {
    if (start >= span.start && end <= span.end) {
      if (options.allowSubspanTypes?.includes(span.type)) return false;
      return true;
    }
    return false;
  });
}
