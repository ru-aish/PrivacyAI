import { createDetectorPipeline } from "./detectors/index.js";
import { redact } from "./redactor.js";
import { generateDummy } from "./dummy-data.js";
import { PRIVACY_SANITIZER_PROMPT } from "./prompts.js";
import { PrivacyGuardianError } from "./errors.js";
import { parseSanitizerJson } from "./parser/sanitizer-json.js";
import { buildSanitizerMessages } from "./prompt-messages.js";

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

    const messages = buildSanitizerMessages({
      systemPrompt: this.systemPrompt,
      text,
      context: options.context
    });

    const response = await this.provider.chat({
      model: this.model,
      messages,
      temperature: 0,
      maxTokens: optionsMaxTokens(this)
    });

    const parsed = parseSanitizerJson(response.text);
    if (parsed) {
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

export { parseSanitizerJson } from "./parser/sanitizer-json.js";

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

    typeCounts[detection.type] = (typeCounts[detection.type] || 0) + 1;
    const dummy = createUniqueDummy(detection.type, typeCounts[detection.type], originalText, sessionMap);
    sessionMap[dummy] = detection.value;
  }

  const llmMapKeys = Object.keys(parsed.session_map);
  const isMangledLlmMap = llmMapKeys.length > 0 && !llmMapKeys.some(key => {
    const val = parsed.session_map[key];
    return val && originalText.toLowerCase().includes(val.toLowerCase()) && key !== val;
  });

  const basePrompt = isMangledLlmMap ? originalText : safePromptBase;

  return {
    safe_prompt: rebuildSafePrompt(basePrompt, sessionMap),
    session_map: sessionMap
  };
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