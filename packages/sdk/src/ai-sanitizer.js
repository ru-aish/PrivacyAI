import { createDetectorPipeline } from "./detectors/index.js";
import { redact } from "./redactor.js";
import { RedactionPlan, createRedactionPlan } from "./redaction-plan.js";
import { shouldRedact } from "./policy/redaction-policy.js";
import { generateDummy } from "./dummy-data.js";
import { PRIVACY_SANITIZER_PROMPT } from "./prompts.js";
import { PrivacyGuardianError } from "./errors.js";

export class AiSanitizer {
  constructor(options = {}) {
    if (!options.provider || typeof options.provider.chat !== "function") {
      throw new PrivacyGuardianError("AiSanitizer requires a provider with chat().");
    }

    this.provider = options.provider;
    this.model = options.privacyModel || options.model;
    this.systemPrompt = options.privacySystemPrompt || PRIVACY_SANITIZER_PROMPT;
    this.privacyMaxTokens = options.privacyMaxTokens;
    this.fallbackDetector = createDetectorPipeline({ ...options, localDetectorEnabled: false });
  }

  async sanitize(text, options = {}) {
    if (typeof text !== "string") {
      throw new TypeError("AiSanitizer.sanitize expects a string prompt.");
    }

    const messages = [
      { role: "system", content: this.systemPrompt }
    ];

    let contextText = "";
    if (options.compactedContextSummary) {
      contextText = options.compactedContextSummary;
      messages.push({
        role: "user",
        content: `[REFERENCE CONTEXT (DO NOT COPY, DO NOT SUMMARIZE, REFERENCE ONLY)]\n${options.compactedContextSummary}`
      });
    } else if (options.context && Array.isArray(options.context) && options.context.length > 0) {
      const summaryLines = options.context.map(turn => `- ${turn.role}: ${turn.text}`).join("\n");
      contextText = summaryLines;
      messages.push({
        role: "user",
        content: `[CONVERSATION REFERENCE HISTORY (DO NOT COPY, DO NOT ANSWER, REFERENCE ONLY)]:\n${summaryLines}`
      });
    }

    messages.push({ role: "user", content: text });

    let response = await this.provider.chat({
      model: this.model,
      messages: messages,
      temperature: 0,
      maxTokens: optionsMaxTokens(this)
    });

    let parsed = parseSanitizerJson(response.text);
    let isValid = false;

    if (parsed) {
      isValid = await validateSanitizerOutput(text, parsed, contextText, this.fallbackDetector);
    }

    if (!isValid) {
      const repairMessages = [
        { role: "system", content: "You are a JSON corrector. You must fix the previous invalid output. Return ONLY the corrected JSON object matching the schema, with no explanation and no markdown. Ensure safe_prompt does NOT contain context references, does NOT answer the request, and stays as close to the original input as possible." },
        { role: "user", content: `Original Input: ${text}\nPrevious Output (Failed validation): ${response.text}\n\nCorrection instruction: Correct the output JSON. Return ONLY the valid JSON.` }
      ];
      try {
        const repairResponse = await this.provider.chat({
          model: this.model,
          messages: repairMessages,
          temperature: 0,
          maxTokens: optionsMaxTokens(this)
        });
        const repairedParsed = parseSanitizerJson(repairResponse.text);
        if (repairedParsed) {
          const repairValid = await validateSanitizerOutput(text, repairedParsed, contextText, this.fallbackDetector);
          if (repairValid) {
            parsed = repairedParsed;
            response = repairResponse;
            isValid = true;
          }
        }
      } catch (err) {
        console.error("Sanitizer repair retry failed:", err);
      }
    }

    if (isValid && parsed) {
      const enforced = await enforceSafeResult(text, parsed, this.fallbackDetector);
      return normalizeSanitizerResult(text, enforced, response, "ai-sanitizer");
    }

    const detections = await this.fallbackDetector.detect(text);
    const fallback = redact(text, detections);
    return {
      ...fallback,
      privacyModelText: response.text,
      privacySource: "regex-fallback"
    };
  }
}

function optionsMaxTokens(sanitizer) {
  return sanitizer.privacyMaxTokens || 2048;
}

export function parseSanitizerJson(text) {
  const json = extractJson(text);
  if (!json || typeof json.safe_prompt !== "string") {
    return null;
  }

  const sessionMap = normalizeSessionMap(json.session_map);
  if (!sessionMap) {
    return null;
  }

  return {
    safe_prompt: json.safe_prompt,
    session_map: sessionMap
  };
}

function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const sessionMap = {};
  for (const [dummy, original] of Object.entries(value)) {
    if (typeof dummy !== "string" || typeof original !== "string") continue;
    if (!dummy || !original) continue;
    sessionMap[dummy] = original;
  }

  return sessionMap;
}

const VAGUE_STANDINS = new Set([
  "api key",
  "api-key",
  "phone number",
  "email address",
  "credit card number",
  "sensitive info",
  "sensitive information",
  "personal information"
]);

function normalizeSessionMapCasing(originalText, sessionMap) {
  const normalized = {};
  const lowerOriginal = originalText.toLowerCase();

  for (const [dummy, original] of Object.entries(sessionMap)) {
    const index = lowerOriginal.indexOf(original.toLowerCase());
    if (index !== -1) {
      normalized[dummy] = originalText.slice(index, index + original.length);
    } else {
      normalized[dummy] = original;
    }
  }

  return normalized;
}

async function enforceSafeResult(originalText, parsed, detector) {
  parsed.session_map = normalizeSessionMapCasing(originalText, parsed.session_map);

  let sessionMap = fixSessionMapOrientation(originalText, parsed.safe_prompt, parsed.session_map);
  sessionMap = removeInvalidSessionMapEntries(originalText, sessionMap);

  const keyReplacements = [];
  const fixedSessionMap = {};
  let vagueCount = 0;

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (!isVagueStandIn(dummy)) {
      fixedSessionMap[dummy] = original;
      continue;
    }

    vagueCount += 1;
    const replacement = createUniqueDummy("API_KEY", vagueCount, originalText, { ...fixedSessionMap, ...sessionMap });
    fixedSessionMap[replacement] = original;
    keyReplacements.push({ oldKey: dummy, newKey: replacement });
  }
  sessionMap = fixedSessionMap;

  let safePromptBase = parsed.safe_prompt;
  for (const { oldKey, newKey } of keyReplacements) {
    const escaped = escapeRegExp(oldKey);
    const regex = new RegExp(escaped, "gi");
    safePromptBase = safePromptBase.replace(regex, newKey);
  }

  const typeCounts = countSessionMapTypes(sessionMap);
  const detections = await detector.detect(originalText);
  for (const detection of detections) {
    if (findDummyForOriginal(sessionMap, detection.value)) continue;
    if (!shouldRedact(detection, { text: originalText })) continue;

    typeCounts[detection.type] = (typeCounts[detection.type] || 0) + 1;
    const dummy = createUniqueDummy(detection.type, typeCounts[detection.type], originalText, sessionMap);
    sessionMap[dummy] = detection.value;
  }

  const llmMapKeys = Object.keys(parsed.session_map);
  const isMangledLlmMap = llmMapKeys.length > 0 && !llmMapKeys.some(key => {
    const val = parsed.session_map[key];
    return val && originalText.toLowerCase().includes(val.toLowerCase()) && key !== val;
  });

  const safePrompt = isMangledLlmMap
    ? buildSafePromptFromPlan(originalText, sessionMap)
    : buildSafePromptFromPlan(safePromptBase, sessionMap);

  return {
    safe_prompt: safePrompt,
    session_map: sessionMap
  };
}

function buildSafePromptFromPlan(baseText, sessionMap) {
  const plan = new RedactionPlan(baseText);

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (dummy === original) continue;
    if (!original) continue;

    const lowerBase = baseText.toLowerCase();
    const lowerOriginal = original.toLowerCase();
    let searchIndex = 0;

    while (searchIndex < baseText.length) {
      const foundIndex = lowerBase.indexOf(lowerOriginal, searchIndex);
      if (foundIndex === -1) break;

      const end = foundIndex + original.length;

      const existing = plan.findReplacement(foundIndex, end);
      if (!existing) {
        plan.addReplacement(foundIndex, end, original, dummy, "SESSION_MAP_OVERRIDE", "session-map");
      }

      searchIndex = end;
    }
  }

  plan.ensureProtectedSpans(plan.protectedSpans);

  return plan.apply();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixSessionMapOrientation(originalText, safePrompt, sessionMap) {
  const fixed = {};
  const lowerOriginal = originalText.toLowerCase();
  const lowerSafe = safePrompt.toLowerCase();

  for (const [key, value] of Object.entries(sessionMap)) {
    const keyInOriginal = lowerOriginal.includes(key.toLowerCase());
    const valueInOriginal = lowerOriginal.includes(value.toLowerCase());
    const keyInSafe = lowerSafe.includes(key.toLowerCase());
    const valueInSafe = lowerSafe.includes(value.toLowerCase());

    if (valueInOriginal && keyInSafe) {
      fixed[key] = value;
      continue;
    }

    if (keyInOriginal && valueInSafe) {
      fixed[value] = key;
      continue;
    }

    if (keyInOriginal && valueInOriginal) {
      if (looksLikeSecret(value) && !looksLikeSecret(key)) {
        fixed[key] = value;
      } else if (looksLikeSecret(key) && !looksLikeSecret(value)) {
        fixed[value] = key;
      } else {
        fixed[key] = value;
      }
      continue;
    }

    if (valueInOriginal) {
      fixed[key] = value;
      continue;
    }

    if (keyInOriginal) {
      fixed[value] = key;
      continue;
    }

    fixed[key] = value;
  }

  return fixed;
}

function removeInvalidSessionMapEntries(originalText, sessionMap) {
  const cleaned = {};
  const lowerOriginal = originalText.toLowerCase();

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (dummy === original) continue;
    if (!lowerOriginal.includes(original.toLowerCase())) continue;
    cleaned[dummy] = original;
  }

  return cleaned;
}

function fixVagueStandInKeys(sessionMap, originalText) {
  const fixed = {};
  let vagueCount = 0;

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (!isVagueStandIn(dummy)) {
      fixed[dummy] = original;
      continue;
    }

    vagueCount += 1;
    const replacement = createUniqueDummy("API_KEY", vagueCount, originalText, { ...fixed, ...sessionMap });
    fixed[replacement] = original;
  }

  return fixed;
}

function rebuildSafePrompt(originalText, sessionMap) {
  let safePrompt = originalText;
  const entries = Object.entries(sessionMap)
    .filter(([dummy, original]) => dummy && original && dummy !== original)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [dummy, original] of entries) {
    const escaped = escapeRegExp(original);
    const regex = new RegExp(escaped, "gi");
    safePrompt = safePrompt.replace(regex, dummy);
  }

  return safePrompt;
}

function countSessionMapTypes(sessionMap) {
  const counts = {};
  for (const original of Object.values(sessionMap)) {
    const type = inferSecretType(original);
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function inferSecretType(value) {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return "EMAIL";
  if (/\bgsk_[A-Za-z0-9]{8,}\b/.test(value)) return "API_KEY";
  if (/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]{8,}\b/.test(value)) return "API_KEY";
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{12,20}\b/.test(value)) return "AWS_ACCESS_KEY";
  if (/\b[a-f0-9]{32,64}\b/i.test(value)) return "API_KEY";
  return "API_KEY";
}

function looksLikeSecret(value) {
  return (
    /[0-9a-f]{16,}/i.test(value) ||
    /^(?:gsk_|sk_|pk_|AKIA)/.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
  );
}

function findDummyForOriginal(sessionMap, original) {
  return Object.entries(sessionMap).find(([, value]) => value === original)?.[0];
}

function createUniqueDummy(type, index, sourceText, sessionMap) {
  let dummy = generateDummy(type, index);
  let slot = index;

  const lowerSource = sourceText.toLowerCase();
  const lowerDummy = dummy.toLowerCase();

  while (lowerSource.includes(lowerDummy) || Object.hasOwn(sessionMap, dummy)) {
    slot += 1;
    dummy = generateDummy(type, slot);
  }

  return dummy;
}

function replaceAll(text, search, replacement) {
  return text.split(search).join(replacement);
}

function isVagueStandIn(value) {
  return VAGUE_STANDINS.has(String(value).trim().toLowerCase());
}

function normalizeSanitizerResult(originalText, parsed, privacyResponse, source) {
  const detections = Object.entries(parsed.session_map).map(([replacement, value]) => {
    const start = originalText.indexOf(value);
    return {
      type: "SENSITIVE",
      value,
      start: start === -1 ? 0 : start,
      end: start === -1 ? value.length : start + value.length,
      confidence: 0.9,
      source,
      replacement
    };
  });

  return {
    originalText,
    sanitizedText: parsed.safe_prompt,
    sessionMap: parsed.session_map,
    detections,
    privacyModelText: privacyResponse.text,
    privacySource: source
  };
}

function extractJson(text) {
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

async function validateSanitizerOutput(originalText, parsedJson, contextText = "", detector = null) {
  if (!parsedJson || typeof parsedJson.safe_prompt !== "string" || !parsedJson.session_map) {
    return false;
  }
  const { safe_prompt, session_map } = parsedJson;

  const upperSafe = safe_prompt.toUpperCase();
  if (upperSafe.includes("CONTEXT") || upperSafe.includes("REFERENCE HISTORY")) {
    return false;
  }

  if (contextText) {
    const cleanText = contextText
      .replace(/\[CONTEXT\]/gi, "")
      .replace(/-\s*(user|assistant):/gi, "")
      .trim();
    const segments = cleanText.split(/[.,!?;\n]/);
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (trimmed.length >= 10 && !originalText.toLowerCase().includes(trimmed.toLowerCase())) {
        if (safe_prompt.toLowerCase().includes(trimmed.toLowerCase())) {
          return false;
        }
      }
    }
  }

  const codeBlockCountOriginal = (originalText.match(/```/g) || []).length;
  const codeBlockCountSafe = (safe_prompt.match(/```/g) || []).length;
  if (codeBlockCountSafe > codeBlockCountOriginal) {
    return false;
  }

  if (safe_prompt.length > originalText.length + 150 && safe_prompt.length > originalText.length * 1.5) {
    return false;
  }

  let cleanOriginal = stripUrls(originalText);
  let cleanSafe = stripUrls(safe_prompt);
  for (const [dummy, original] of Object.entries(session_map || {})) {
    if (original && typeof original === "string") {
      cleanOriginal = cleanOriginal.replace(new RegExp(escapeRegExp(original), "gi"), "");
    }
    if (dummy && typeof dummy === "string") {
      cleanSafe = cleanSafe.replace(new RegExp(escapeRegExp(dummy), "gi"), "");
    }
  }

  let hasSensitive = false;
  if (detector) {
    const detections = await detector.detect(originalText);
    const sensitiveDetections = detections.filter(d => shouldRedact(d, { text: originalText }));
    hasSensitive = sensitiveDetections.length > 0;
  }

  const threshold = hasSensitive
    ? Math.max(40, cleanOriginal.trim().length * 0.45)
    : Math.max(12, cleanOriginal.trim().length * 0.15);

  const dist = getEditDistance(cleanOriginal.trim(), cleanSafe.trim());
  if (dist > threshold) {
    return false;
  }

  return true;
}

function getEditDistance(a, b) {
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  let prevRow = new Array(lenA + 1);
  let currRow = new Array(lenA + 1);

  for (let j = 0; j <= lenA; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= lenB; i++) {
    currRow[0] = i;
    for (let j = 1; j <= lenA; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        currRow[j] = prevRow[j - 1];
      } else {
        currRow[j] = Math.min(
          prevRow[j - 1] + 1,
          Math.min(
            currRow[j - 1] + 1,
            prevRow[j] + 1
          )
        );
      }
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[lenA];
}

function stripUrls(str) {
  return str.replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"']+/gi, "");
}


