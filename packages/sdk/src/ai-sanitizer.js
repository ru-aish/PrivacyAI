import { createDetectorPipeline, mergeDetections } from "./detectors/index.js";
import { redact } from "./redactor.js";
import { RedactionPlan } from "./redaction-plan.js";
import { shouldRedact } from "./policy/redaction-policy.js";
import { generateDummy } from "./dummy-data.js";
import {
  BROWSER_PRIVACY_SANITIZER_PROMPT,
  STRICT_PRIVACY_SANITIZER_PROMPT
} from "./prompts.js";
import { PrivacyGuardianError } from "./errors.js";

export const SANITIZATION_MODES = Object.freeze({
  STRICT: "strict",
  BROWSER: "browser"
});

const STRICT_ALWAYS_SENSITIVE_TYPES = new Set([
  "EMAIL", "SSN", "CREDIT_CARD", "PHONE", "API_KEY", "AWS_ACCESS_KEY",
  "URL_CREDENTIAL", "URL_QUERY_SECRET", "CONNECTION_STRING_CREDENTIAL",
  "MEDICAL_ID", "MRN", "PRIVATE_IDENTIFIER"
]);

const STRICT_IDENTITY_TYPES = new Set(["PERSON", "ORGANIZATION", "LOCATION"]);

export class AiSanitizer {
  constructor(options = {}) {
    if (!options.provider || typeof options.provider.chat !== "function") {
      throw new PrivacyGuardianError("AiSanitizer requires a provider with chat().");
    }

    this.provider = options.provider;
    this.model = options.privacyModel || options.model;
    this.sanitizationMode = normalizeSanitizationMode(
      options.sanitizationMode || options.privacyMode || SANITIZATION_MODES.STRICT
    );
    this.systemPrompt = options.privacySystemPrompt || promptForMode(this.sanitizationMode);
    this.privacyMaxTokens = options.privacyMaxTokens;
    this.fallbackDetector = createDetectorPipeline({ ...options, localDetectorEnabled: false });
  }

  async sanitize(text, options = {}) {
    if (typeof text !== "string") {
      throw new TypeError("AiSanitizer.sanitize expects a string prompt.");
    }

    const messages = [{ role: "system", content: this.systemPrompt }];

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
      messages,
      temperature: 0,
      maxTokens: optionsMaxTokens(this)
    });

    let parsed = parseSanitizerJson(response.text);
    let isValid = parsed
      ? await validateSanitizerOutput(
          text,
          parsed,
          contextText,
          this.fallbackDetector,
          this.sanitizationMode
        )
      : false;

    if (!isValid) {
      const repairMessages = buildRepairMessages(text, response.text, this.sanitizationMode);
      try {
        const repairResponse = await this.provider.chat({
          model: this.model,
          messages: repairMessages,
          temperature: 0,
          maxTokens: optionsMaxTokens(this)
        });
        const repairedParsed = parseSanitizerJson(repairResponse.text);
        if (repairedParsed) {
          const repairValid = await validateSanitizerOutput(
            text,
            repairedParsed,
            contextText,
            this.fallbackDetector,
            this.sanitizationMode
          );
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
      const enforced = this.sanitizationMode === SANITIZATION_MODES.STRICT
        ? await enforceStrictSafeResult(text, parsed, this.fallbackDetector)
        : await enforceBrowserSafeResult(text, parsed, this.fallbackDetector);
      return normalizeSanitizerResult(text, enforced, response, "ai-sanitizer");
    }

    const detections = await this.fallbackDetector.detect(text);
    const fallback = this.sanitizationMode === SANITIZATION_MODES.STRICT
      ? buildStrictRedactionPlan(text, detections).toResult("strict-regex-fallback")
      : redact(text, detections);
    return {
      ...fallback,
      privacyModelText: response.text,
      privacySource: "regex-fallback"
    };
  }
}

function promptForMode(mode) {
  return mode === SANITIZATION_MODES.BROWSER
    ? BROWSER_PRIVACY_SANITIZER_PROMPT
    : STRICT_PRIVACY_SANITIZER_PROMPT;
}

function normalizeSanitizationMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === SANITIZATION_MODES.STRICT || normalized === SANITIZATION_MODES.BROWSER) {
    return normalized;
  }
  throw new TypeError(`Unsupported sanitization mode: ${value}`);
}

function optionsMaxTokens(sanitizer) {
  return sanitizer.privacyMaxTokens || 2048;
}

function buildRepairMessages(originalText, previousOutput, mode) {
  const modeInstruction = mode === SANITIZATION_MODES.STRICT
    ? "Copy the original input exactly and replace only the smallest exact private substrings. Do not rewrite any other character. Every session_map value must be an exact substring of Original Input."
    : "Preserve the original request, line breaks, quoted content, technical details, and all constraints. Make only minimal local privacy edits. Every session_map key must appear in safe_prompt and every value must be an exact substring of Original Input.";

  return [
    {
      role: "system",
      content: `You are a JSON corrector. Return ONLY one valid JSON object with safe_prompt and session_map. No explanation or markdown. ${modeInstruction}`
    },
    {
      role: "user",
      content: `Original Input:\n${originalText}\n\nPrevious Output (failed validation):\n${previousOutput}\n\nCorrect the JSON only.`
    }
  ];
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
    normalized[dummy] = index === -1
      ? original
      : originalText.slice(index, index + original.length);
  }

  return normalized;
}

async function enforceStrictSafeResult(originalText, parsed, detector) {
  const detectorDetections = await detector.detect(originalText);
  const oriented = fixSessionMapOrientation(
    originalText,
    parsed.safe_prompt,
    normalizeSessionMapCasing(originalText, parsed.session_map)
  );
  const modelMap = removeInvalidSessionMapEntries(originalText, oriented);
  const modelDetections = sessionMapToDetections(originalText, modelMap, detectorDetections);
  const combined = mergeDetections([...detectorDetections, ...modelDetections]);
  const plan = buildStrictRedactionPlan(originalText, combined);

  return {
    safe_prompt: plan.apply(),
    session_map: { ...plan.sessionMap }
  };
}

function buildStrictRedactionPlan(originalText, detections) {
  const plan = new RedactionPlan(originalText);
  const typeCounts = {};
  const reusableDummies = new Map();

  for (const detection of detections) {
    if (!shouldRedactStrict(detection, originalText)) continue;
    if (plan.replacements.some(current => rangesOverlap(current, detection))) continue;

    const type = normalizeReplacementType(detection.type);
    const valueKey = `${type}\0${detection.value}`;
    let dummy = reusableDummies.get(valueKey);
    if (!dummy) {
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      dummy = plan.createUniqueDummy(type, typeCounts[type]);
      reusableDummies.set(valueKey, dummy);
    }

    plan.addReplacement(
      detection.start,
      detection.end,
      originalText.slice(detection.start, detection.end),
      dummy,
      type,
      detection.source || "strict"
    );
  }

  return plan;
}

function shouldRedactStrict(detection, text) {
  if (STRICT_ALWAYS_SENSITIVE_TYPES.has(detection.type)) return true;
  if (STRICT_IDENTITY_TYPES.has(detection.type)) return detection.confidence >= 0.65;
  return shouldRedact(detection, { text });
}

function sessionMapToDetections(originalText, sessionMap, detectorDetections) {
  const detections = [];
  const lowerOriginal = originalText.toLowerCase();

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (typeof dummy !== "string" || typeof original !== "string" || !dummy || !original) continue;
    const lowerValue = original.toLowerCase();
    const type = inferModelDetectionType(dummy, original, detectorDetections);
    let searchIndex = 0;

    while (searchIndex < originalText.length) {
      const start = lowerOriginal.indexOf(lowerValue, searchIndex);
      if (start === -1) break;
      const end = start + original.length;
      detections.push({
        type,
        value: originalText.slice(start, end),
        start,
        end,
        confidence: 1,
        source: "local-ai-map"
      });
      searchIndex = end;
    }
  }

  return detections;
}

function inferModelDetectionType(dummy, original, detectorDetections) {
  const detected = detectorDetections.find(d =>
    d.value.toLowerCase() === original.toLowerCase()
  );
  if (detected) return detected.type;

  const hint = `${dummy} ${original}`;
  if (/email|@/i.test(hint)) return "EMAIL";
  if (/phone|mobile|telephone/i.test(hint)) return "PHONE";
  if (/person|name/i.test(dummy)) return "PERSON";
  if (/company|organization|organisation|employer/i.test(dummy)) return "ORGANIZATION";
  if (/location|address|city|country/i.test(dummy)) return "LOCATION";
  if (/mrn|medical|patient/i.test(dummy)) return "MEDICAL_ID";
  if (/invoice|account|customer|employee|private[_ -]?id|identifier/i.test(dummy)) {
    return "PRIVATE_IDENTIFIER";
  }
  return inferSecretType(original);
}

async function enforceBrowserSafeResult(originalText, parsed, detector) {
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
    const type = inferSecretType(original);
    const replacement = createUniqueDummy(type, vagueCount, originalText, { ...fixedSessionMap, ...sessionMap });
    fixedSessionMap[replacement] = original;
    keyReplacements.push({ oldKey: dummy, newKey: replacement });
  }
  sessionMap = fixedSessionMap;

  let safePromptBase = parsed.safe_prompt;
  for (const { oldKey, newKey } of keyReplacements) {
    safePromptBase = safePromptBase.replace(new RegExp(escapeRegExp(oldKey), "gi"), newKey);
  }

  const typeCounts = countSessionMapTypes(sessionMap);
  const detections = await detector.detect(originalText);
  for (const detection of detections) {
    if (findDummyForOriginal(sessionMap, detection.value)) continue;
    if (!shouldRedactStrict(detection, originalText)) continue;

    const type = normalizeReplacementType(detection.type);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    const dummy = createUniqueDummy(type, typeCounts[type], originalText, sessionMap);
    sessionMap[dummy] = detection.value;
  }

  return {
    safe_prompt: buildSafePromptFromPlan(safePromptBase, sessionMap),
    session_map: sessionMap
  };
}

function buildSafePromptFromPlan(baseText, sessionMap) {
  const plan = new RedactionPlan(baseText);

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (dummy === original || !original) continue;

    const lowerBase = baseText.toLowerCase();
    const lowerOriginal = original.toLowerCase();
    let searchIndex = 0;

    while (searchIndex < baseText.length) {
      const foundIndex = lowerBase.indexOf(lowerOriginal, searchIndex);
      if (foundIndex === -1) break;
      const end = foundIndex + original.length;

      if (!plan.replacements.some(current => rangesOverlap(current, { start: foundIndex, end }))) {
        plan.addReplacement(
          foundIndex,
          end,
          baseText.slice(foundIndex, end),
          dummy,
          "SESSION_MAP_OVERRIDE",
          "session-map"
        );
      }
      searchIndex = end;
    }
  }

  return plan.apply();
}

function fixSessionMapOrientation(originalText, safePrompt, sessionMap) {
  const fixed = {};
  const lowerOriginal = originalText.toLowerCase();
  const lowerSafe = safePrompt.toLowerCase();

  for (const [key, value] of Object.entries(sessionMap)) {
    if (typeof key !== "string" || typeof value !== "string" || !key || !value) continue;
    const keyInOriginal = lowerOriginal.includes(key.toLowerCase());
    const valueInOriginal = lowerOriginal.includes(value.toLowerCase());
    const keyInSafe = lowerSafe.includes(key.toLowerCase());
    const valueInSafe = lowerSafe.includes(value.toLowerCase());

    if (valueInOriginal && keyInSafe) {
      fixed[key] = value;
    } else if (keyInOriginal && valueInSafe) {
      fixed[value] = key;
    } else if (keyInOriginal && valueInOriginal) {
      if (looksLikeSecret(value) && !looksLikeSecret(key)) fixed[key] = value;
      else if (looksLikeSecret(key) && !looksLikeSecret(value)) fixed[value] = key;
      else fixed[key] = value;
    } else if (valueInOriginal) {
      fixed[key] = value;
    } else if (keyInOriginal) {
      fixed[value] = key;
    }
  }

  return fixed;
}

function removeInvalidSessionMapEntries(originalText, sessionMap) {
  const cleaned = {};
  const lowerOriginal = originalText.toLowerCase();

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (typeof dummy !== "string" || typeof original !== "string" || !dummy || !original) continue;
    if (dummy === original) continue;
    if (!lowerOriginal.includes(original.toLowerCase())) continue;
    if (/\r|\n/.test(original)) continue;
    if (original.length > 512) continue;
    if (original.length > 80 && original.length > originalText.length * 0.35) continue;
    cleaned[dummy] = original;
  }

  return cleaned;
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
  if (/^\+?\d[\d\s().-]{7,}\d$/.test(value.trim())) return "PHONE";
  if (/\bMRN[-\s]?\d{5,}\b/i.test(value)) return "MRN";
  if (/\bgsk_[A-Za-z0-9]{8,}\b/.test(value)) return "API_KEY";
  if (/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]{8,}\b/.test(value)) return "API_KEY";
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{12,20}\b/.test(value)) return "AWS_ACCESS_KEY";
  if (/\b[a-f0-9]{32,64}\b/i.test(value)) return "API_KEY";
  return "PRIVATE_IDENTIFIER";
}

function normalizeReplacementType(type) {
  return type || "PRIVATE_IDENTIFIER";
}

function looksLikeSecret(value) {
  return (
    /[0-9a-f]{16,}/i.test(value) ||
    /^(?:gsk_|sk_|pk_|AKIA)/.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
  );
}

function findDummyForOriginal(sessionMap, original) {
  if (typeof original !== "string" || !original) return undefined;
  const target = original.toLowerCase();
  return Object.entries(sessionMap).find(
    ([dummy, value]) =>
      typeof dummy === "string" &&
      typeof value === "string" &&
      dummy.length > 0 &&
      value.length > 0 &&
      value.toLowerCase() === target
  )?.[0];
}

function createUniqueDummy(type, index, sourceText, sessionMap) {
  let dummy = generateDummy(type, index);
  let slot = index;
  const lowerSource = sourceText.toLowerCase();

  while (lowerSource.includes(dummy.toLowerCase()) || Object.hasOwn(sessionMap, dummy)) {
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
    const start = originalText.toLowerCase().indexOf(value.toLowerCase());
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

async function validateSanitizerOutput(
  originalText,
  parsedJson,
  contextText = "",
  detector = null,
  mode = SANITIZATION_MODES.STRICT
) {
  if (!parsedJson || typeof parsedJson.safe_prompt !== "string" || !parsedJson.session_map) {
    return false;
  }

  if (!passesContextIsolation(originalText, parsedJson.safe_prompt, contextText)) {
    return false;
  }

  const oriented = fixSessionMapOrientation(
    originalText,
    parsedJson.safe_prompt,
    normalizeSessionMapCasing(originalText, parsedJson.session_map)
  );

  if (!sessionMapReferencesOriginal(originalText, oriented)) {
    return false;
  }

  if (mode === SANITIZATION_MODES.STRICT) {
    return true;
  }

  return validateBrowserRewrite(originalText, parsedJson.safe_prompt, oriented);
}

function passesContextIsolation(originalText, safePrompt, contextText) {
  const upperSafe = safePrompt.toUpperCase();
  if (upperSafe.includes("[CONTEXT]") || upperSafe.includes("REFERENCE HISTORY")) {
    return false;
  }

  if (!contextText) return true;

  const cleanText = contextText
    .replace(/\[CONTEXT\]/gi, "")
    .replace(/-\s*(user|assistant):/gi, "")
    .trim();
  const segments = cleanText.split(/[.,!?;\n]/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length < 10) continue;
    if (originalText.toLowerCase().includes(trimmed.toLowerCase())) continue;
    if (safePrompt.toLowerCase().includes(trimmed.toLowerCase())) return false;
  }

  return true;
}

function sessionMapReferencesOriginal(originalText, sessionMap) {
  const lowerOriginal = originalText.toLowerCase();
  for (const original of Object.values(sessionMap)) {
    if (!lowerOriginal.includes(original.toLowerCase())) return false;
    if (/\r|\n/.test(original)) return false;
  }
  return true;
}

function validateBrowserRewrite(originalText, safePrompt, sessionMap) {
  const lowerSafe = safePrompt.toLowerCase();
  for (const dummy of Object.keys(sessionMap)) {
    if (!lowerSafe.includes(dummy.toLowerCase())) return false;
  }

  if (lineBreakSignature(originalText) !== lineBreakSignature(safePrompt)) return false;
  if ((originalText.match(/```/g) || []).length !== (safePrompt.match(/```/g) || []).length) return false;

  const minimumLength = Math.max(0, originalText.length * 0.72 - 80);
  const maximumLength = originalText.length * 1.25 + 120;
  if (safePrompt.length < minimumLength || safePrompt.length > maximumLength) return false;

  let maskedOriginal = originalText;
  let maskedSafe = safePrompt;
  for (const [dummy, original] of Object.entries(sessionMap)) {
    maskedOriginal = maskedOriginal.replace(new RegExp(escapeRegExp(original), "gi"), " [PRIVATE] ");
    maskedSafe = maskedSafe.replace(new RegExp(escapeRegExp(dummy), "gi"), " [PRIVATE] ");
  }

  return tokenOrderCoverage(maskedOriginal, maskedSafe) >= 0.68;
}

function tokenOrderCoverage(originalText, safeText) {
  const originalTokens = tokenizeForSimilarity(originalText);
  const safeTokens = tokenizeForSimilarity(safeText);
  if (originalTokens.length === 0) return safeTokens.length === 0 ? 1 : 0;

  const positions = new Map();
  for (let index = 0; index < safeTokens.length; index += 1) {
    const token = safeTokens[index];
    if (!positions.has(token)) positions.set(token, []);
    positions.get(token).push(index);
  }

  let safeIndex = 0;
  let matches = 0;
  for (const token of originalTokens) {
    const candidates = positions.get(token);
    if (!candidates) continue;
    const candidateIndex = lowerBound(candidates, safeIndex);
    if (candidateIndex >= candidates.length) continue;
    matches += 1;
    safeIndex = candidates[candidateIndex] + 1;
  }

  return matches / originalTokens.length;
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function tokenizeForSimilarity(text) {
  return String(text)
    .toLowerCase()
    .match(/[\p{L}\p{N}_@.+:/-]+|\[private\]/gu) || [];
}

function lineBreakSignature(text) {
  return (String(text).match(/\r\n|\r|\n/g) || []).join("|");
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
