const CODE_BLOCK_REGEX = /(?:```[\s\S]*?```|`[^`\n]+`)/g;

// Schemes supported for URLs/connection strings
const URL_REGEX = /\b(?:https?|ftp|postgres|postgresql|mysql|mongodb|redis|amqp|kafka):\/\/[^\s<>"'`]+/gi;
const WWW_REGEX = /\bwww\.[^\s<>"'`]+/gi;

// Stack trace line regex (e.g., "at Object.<anonymous> (/path/to/file.js:10:11)")
const STACK_TRACE_REGEX = /(?:\r?\n|^)\s*at\s+[^\r\n]+/g;

// File paths: starting with / (not part of a word), ./, ../, or containing typical file extensions
const FILE_PATH_PREFIX_REGEX = /(?:\B\.\.?\/|(?<!\w)\/)[a-zA-Z0-9_\-\.]+(?:\/[a-zA-Z0-9_\-\.]+)+/g;
const FILE_PATH_EXT_REGEX = /\b[a-zA-Z0-9_\-\.\/]+\.(?:js|ts|py|go|java|c|cpp|h|html|css|json|yaml|yml|md|sh|txt|conf|ini|env|sql|xml|mjs|cjs)\b/g;

// Endpoint paths (similar to paths but specifically starting with REST/API typical prefixes or short paths)
const ENDPOINT_REGEX = /(?<!\w)\/(?:api|v\d+|users|auth|posts|comments|settings|oauth|callback)(?:\/[a-zA-Z0-9_\-]+)*\b/g;

// Command line flags and CLI keywords
const CLI_FLAG_REGEX = /(?<!\w)\-\-[a-zA-Z0-9_\-]+(?:\=[a-zA-Z0-9_\-]+)?\b|(?<!\w)\-[a-zA-Z0-9]\b/g;
const CLI_CMD_REGEX = /\b(?:npm|pnpm|yarn|node|git|docker|kubectl|aws|gcloud|curl|wget|python|pip|cargo|go)\s+[a-zA-Z0-9_\-\s\.\/]+/g;

// Known Model Names
const MODEL_NAME_REGEX = /\b(?:gemini|gpt|claude|llama|qwen|mistral|phi|deepseek|local-model|gemma)(?:-[a-zA-Z0-9_\.]+)*(?::[a-zA-Z0-9_\.]+)?\b/gi;

// Package Names
const PACKAGE_NAME_REGEX = /\b@[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+\b/g;

export function findProtectedSpans(text) {
  const spans = [];

  const addMatches = (regex, type) => {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      spans.push({
        type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
  };

  addMatches(CODE_BLOCK_REGEX, "CODE_BLOCK");
  addMatches(URL_REGEX, "URL");
  addMatches(WWW_REGEX, "URL");
  addMatches(STACK_TRACE_REGEX, "STACK_TRACE");
  addMatches(FILE_PATH_PREFIX_REGEX, "FILE_PATH");
  addMatches(FILE_PATH_EXT_REGEX, "FILE_PATH");
  addMatches(ENDPOINT_REGEX, "ENDPOINT");
  addMatches(CLI_FLAG_REGEX, "CLI_FLAG");
  addMatches(CLI_CMD_REGEX, "CLI_COMMAND");
  addMatches(MODEL_NAME_REGEX, "MODEL_NAME");
  addMatches(PACKAGE_NAME_REGEX, "PACKAGE_NAME");

  return mergeOverlappingSpans(spans);
}

function mergeOverlappingSpans(spans) {
  if (spans.length === 0) return [];

  const sorted = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });

  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.start < last.end) {
      if (current.end <= last.end) {
        continue;
      }
      last.end = current.end;
      last.value = last.value + current.value.slice(last.end - current.start);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

export function findRedactableSubspans(text, protectedSpans) {
  const subspans = [];

  const urlSpans = protectedSpans.filter(span => span.type === "URL");

  for (const urlSpan of urlSpans) {
    const urlStr = urlSpan.value;
    const urlStart = urlSpan.start;

    const querySecretRegex = /[?&](token|access_token|api_key|signature|password|secret|sig)=([^&\s#`"'\)]+)/gi;
    let match;
    while ((match = querySecretRegex.exec(urlStr)) !== null) {
      const paramName = match[1];
      const paramValue = match[2];
      const valOffset = match[0].indexOf(paramValue);
      const valueIndex = urlStart + match.index + valOffset;

      subspans.push({
        type: "URL_QUERY_SECRET",
        value: paramValue,
        start: valueIndex,
        end: valueIndex + paramValue.length,
        action: "redact",
        replacementType: "API_KEY",
        protectedParent: "URL"
      });
    }

    const userinfoRegex = /([a-zA-Z0-9_\-\+\.]+):\/\/([^/\s@]+)@/gi;
    let userinfoMatch;
    userinfoRegex.lastIndex = 0;
    while ((userinfoMatch = userinfoRegex.exec(urlStr)) !== null) {
      const scheme = userinfoMatch[1];
      const userinfo = userinfoMatch[2];
      const colonIndex = userinfo.indexOf(":");

      let secretValue = "";
      let secretIndexOffset = 0;

      if (colonIndex !== -1) {
        secretValue = userinfo.slice(colonIndex + 1);
        secretIndexOffset = colonIndex + 1;
      } else {
        const dbSchemes = ["postgres", "postgresql", "mysql", "mongodb", "redis", "amqp", "kafka"];
        if (dbSchemes.includes(scheme.toLowerCase())) {
          secretValue = userinfo;
          secretIndexOffset = 0;
        }
      }

      if (secretValue) {
        const userinfoStartInUrl = userinfoMatch.index + userinfoMatch[0].indexOf(userinfo);
        const valueIndex = urlStart + userinfoStartInUrl + secretIndexOffset;

        subspans.push({
          type: "URL_USERINFO_SECRET",
          value: secretValue,
          start: valueIndex,
          end: valueIndex + secretValue.length,
          action: "redact",
          replacementType: "API_KEY",
          protectedParent: "URL"
        });
      }
    }
  }

  return subspans;
}
