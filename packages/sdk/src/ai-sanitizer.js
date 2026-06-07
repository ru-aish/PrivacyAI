import { createDetectorPipeline } from "./detectors/index.js";
import { redact } from "./redactor.js";
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
    this.fallbackDetector = createDetectorPipeline({ ...options, localDetectorEnabled: false });
  }

  async sanitize(text) {
    if (typeof text !== "string") {
      throw new TypeError("AiSanitizer.sanitize expects a string prompt.");
    }

    const response = await this.provider.chat({
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: text }
      ],
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

async function enforceSafeResult(originalText, parsed, detector) {
  let safePrompt = parsed.safe_prompt;
  const sessionMap = fixSessionMapOrientation(originalText, safePrompt, parsed.session_map);
  const typeCounts = {};

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (safePrompt.includes(original)) {
      safePrompt = replaceAll(safePrompt, original, dummy);
    }
  }

  const detections = await detector.detect(originalText);
  for (const detection of detections) {
    if (!safePrompt.includes(detection.value)) continue;

    let dummy = findDummyForOriginal(sessionMap, detection.value);
    if (!dummy) {
      typeCounts[detection.type] = (typeCounts[detection.type] || 0) + 1;
      dummy = createUniqueDummy(detection.type, typeCounts[detection.type], safePrompt, sessionMap);
      sessionMap[dummy] = detection.value;
    }

    safePrompt = replaceAll(safePrompt, detection.value, dummy);
  }

  return {
    safe_prompt: safePrompt,
    session_map: sessionMap
  };
}

function fixSessionMapOrientation(originalText, safePrompt, sessionMap) {
  const fixed = {};

  for (const [key, value] of Object.entries(sessionMap)) {
    const keyInOriginal = originalText.includes(key);
    const valueInOriginal = originalText.includes(value);
    const keyInSafe = safePrompt.includes(key);
    const valueInSafe = safePrompt.includes(value);

    if (valueInOriginal && keyInSafe) {
      fixed[key] = value;
      continue;
    }

    if (keyInOriginal && valueInSafe) {
      fixed[value] = key;
      continue;
    }

    if (keyInOriginal) {
      const dummy = valueInSafe ? value : key;
      const original = keyInOriginal ? key : value;
      if (dummy !== original) {
        fixed[dummy] = original;
      }
      continue;
    }

    fixed[key] = value;
  }

  return fixed;
}

function findDummyForOriginal(sessionMap, original) {
  return Object.entries(sessionMap).find(([, value]) => value === original)?.[0];
}

function createUniqueDummy(type, index, safePrompt, sessionMap) {
  let dummy = generateDummy(type, index);
  let slot = index;

  while (safePrompt.includes(dummy) || Object.hasOwn(sessionMap, dummy)) {
    slot += 1;
    dummy = generateDummy(type, slot);
  }

  return dummy;
}

function replaceAll(text, search, replacement) {
  return text.split(search).join(replacement);
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
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}