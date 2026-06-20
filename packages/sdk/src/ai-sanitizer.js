import { createDetectorPipeline } from "./detectors/index.js";
import { redact, restore } from "./redactor.js";
import { generateDummy } from "./dummy-data.js";
import { PRIVACY_SANITIZER_PROMPT } from "./prompts.js";
import { PrivacyGuardianError } from "./errors.js";
import { classifyDetections } from "./policy/redaction-policy.js";
import { buildRedactionPlan, applyRedactionPlan } from "./redaction-plan.js";
import { localSanitize } from "./local-sanitizer.js";
import { findProtectedSpans, findRedactableSubspans } from "./policy/protected-spans.js";

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

    this.sanitizeContextBeforeProvider = options.sanitizeContextBeforeProvider;
    if (this.sanitizeContextBeforeProvider === undefined) {
      const baseUrl = options.baseURL || options.baseUrl || (this.provider && this.provider.baseURL) || (this.provider && this.provider.baseUrl) || "";
      this.sanitizeContextBeforeProvider = isRemoteUrl(baseUrl);
    }
  }

  async sanitize(text, options = {}) {
    if (typeof text !== "string") {
      throw new TypeError("AiSanitizer.sanitize expects a string prompt.");
    }

    let contextTurns = options.context || [];
    if (this.sanitizeContextBeforeProvider && contextTurns.length > 0) {
      const sanitizedTurns = [];
      for (const turn of contextTurns) {
        const localSanitized = await localSanitize(turn.text);
        sanitizedTurns.push({
          role: turn.role,
          text: localSanitized.sanitizedText
        });
      }
      contextTurns = sanitizedTurns;
    }

    const messages = [
      { role: "system", content: this.systemPrompt }
    ];

    if (contextTurns.length > 0) {
      for (const turn of contextTurns) {
        messages.push({
          role: turn.role === "user" ? "user" : "assistant",
          content: `[CONTEXT] ${turn.text}`
        });
      }
    }

    messages.push({ role: "user", content: text });

    let response = null;
    let parsed = null;

    try {
      // Attempt 1: normal JSON prompt
      response = await this.provider.chat({
        model: this.model,
        messages: messages,
        temperature: 0,
        maxTokens: optionsMaxTokens(this)
      });
      parsed = parseSanitizerJson(response.text);
    } catch (err) {
      console.warn("AiSanitizer chat attempt 1 failed:", err.message);
    }

    // Attempt 2: stricter repair prompt
    if (!parsed && response) {
      try {
        const repairMessages = [
          ...messages,
          { role: "assistant", content: response.text },
          { 
            role: "user", 
            content: "Your response was not valid JSON. Please reply with ONLY a valid JSON object containing 'safe_prompt' and 'session_map' keys, following the schema. Do not include markdown formatting or explanations." 
          }
        ];
        const repairResponse = await this.provider.chat({
          model: this.model,
          messages: repairMessages,
          temperature: 0,
          maxTokens: optionsMaxTokens(this)
        });
        parsed = parseSanitizerJson(repairResponse.text);
        if (parsed) {
          response = repairResponse;
        }
      } catch (err) {
        console.warn("AiSanitizer chat attempt 2 failed:", err.message);
      }
    }

    if (parsed) {
      try {
        const enforced = await enforceSafeResult(text, parsed, this.fallbackDetector, options);
        const validation = validateSanitizedOutput(text, enforced.safe_prompt, enforced.session_map, options);
        if (validation.valid) {
          return normalizeSanitizerResult(text, enforced, response, "ai-sanitizer");
        } else {
          console.warn("Sanitization validation failed:", validation.error);
        }
      } catch (enforceError) {
        console.error("Error during AI enforcement or validation:", enforceError);
      }
    }

    // Attempt 3: deterministic fallback
    const detections = await this.fallbackDetector.detect(text);
    const fallback = redact(text, detections, options);
    return {
      ...fallback,
      privacyModelText: response ? response.text : null,
      privacySource: "regex-fallback"
    };
  }
}

function isRemoteUrl(urlStr) {
  if (!urlStr) return true;
  try {
    const url = new URL(urlStr);
    const host = url.hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return true;
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

export function applyReplacementsToPrompt(prompt, decisions, sessionMap) {
  const protectedSpans = findProtectedSpans(prompt);
  const redactableSubspans = findRedactableSubspans(prompt, protectedSpans);

  const occurrences = [];

  for (const decision of decisions) {
    const original = decision.value;
    const dummy = Object.entries(sessionMap).find(
      ([d, o]) => o.toLowerCase() === original.toLowerCase()
    )?.[0];
    if (!dummy) continue;

    const lowerPrompt = prompt.toLowerCase();
    const lowerOriginal = original.toLowerCase();

    let idx = lowerPrompt.indexOf(lowerOriginal);
    while (idx !== -1) {
      const start = idx;
      const end = idx + original.length;

      const parentSpan = protectedSpans.find(
        (p) => start >= p.start && end <= p.end
      );

      let shouldRedact = true;
      if (parentSpan) {
        const isRedactableSub = redactableSubspans.some(
          (sub) => start >= sub.start && end <= sub.end
        );
        if (!isRedactableSub) {
          shouldRedact = false;
        }
      }

      if (shouldRedact) {
        occurrences.push({
          start,
          end,
          original,
          replacement: dummy
        });
      }

      idx = lowerPrompt.indexOf(lowerOriginal, idx + 1);
    }
  }

  const resolved = [];
  const sorted = occurrences.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.original.length - a.original.length;
  });

  for (const occ of sorted) {
    if (!resolved.some(r => occ.start < r.end && r.start < occ.end)) {
      resolved.push(occ);
    }
  }

  let resultText = prompt;
  for (const occ of resolved.sort((a, b) => b.start - a.start)) {
    resultText =
      resultText.slice(0, occ.start) +
      occ.replacement +
      resultText.slice(occ.end);
  }

  return resultText;
}

async function enforceSafeResult(originalText, parsed, detector, options = {}) {
  parsed.session_map = normalizeSessionMapCasing(originalText, parsed.session_map);

  let sessionMap = fixSessionMapOrientation(originalText, parsed.safe_prompt, parsed.session_map);
  sessionMap = removeInvalidSessionMapEntries(originalText, sessionMap);

  const fixedSessionMap = {};
  const vagueKeyReplacements = {};
  let vagueCount = 0;

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (!isVagueStandIn(dummy)) {
      fixedSessionMap[dummy] = original;
      continue;
    }

    vagueCount += 1;
    const replacement = createUniqueDummy("API_KEY", vagueCount, originalText, { ...fixedSessionMap, ...sessionMap });
    fixedSessionMap[replacement] = original;
    vagueKeyReplacements[dummy] = replacement;
  }

  let safePromptBase = parsed.safe_prompt;
  for (const [oldKey, newKey] of Object.entries(vagueKeyReplacements)) {
    const escaped = escapeRegExp(oldKey);
    const regex = new RegExp(escaped, "gi");
    safePromptBase = safePromptBase.replace(regex, newKey);
  }

  const aiCandidates = [];
  const lowerOriginalText = originalText.toLowerCase();
  for (const [dummy, original] of Object.entries(fixedSessionMap)) {
    const lowerOriginal = original.toLowerCase();
    let idx = lowerOriginalText.indexOf(lowerOriginal);
    while (idx !== -1) {
      const actualVal = originalText.slice(idx, idx + original.length);
      aiCandidates.push({
        type: inferSecretType(original),
        value: actualVal,
        start: idx,
        end: idx + original.length,
        confidence: 0.95,
        source: "ai-proposed",
        replacement: dummy
      });
      idx = lowerOriginalText.indexOf(lowerOriginal, idx + 1);
    }
  }

  const detectorCandidates = await detector.detect(originalText);
  const combinedCandidates = [...aiCandidates, ...detectorCandidates];
  const decisions = classifyDetections(originalText, combinedCandidates, options);

  const plan = buildRedactionPlan(originalText, decisions, fixedSessionMap);

  const llmMapKeys = Object.keys(parsed.session_map);
  const isMangledLlmMap = llmMapKeys.length > 0 && !llmMapKeys.some(key => {
    const val = parsed.session_map[key];
    return val && originalText.toLowerCase().includes(val.toLowerCase()) && key !== val;
  });

  let safePrompt;
  if (isMangledLlmMap) {
    safePrompt = applyRedactionPlan(plan);
  } else {
    safePrompt = applyReplacementsToPrompt(safePromptBase, decisions, plan.sessionMap);
  }

  return {
    safe_prompt: safePrompt,
    session_map: plan.sessionMap
  };
}

export function validateSanitizedOutput(originalText, sanitizedText, sessionMap, options = {}) {
  const lowerSanitized = sanitizedText.toLowerCase();
  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (dummy === original) continue;
    if (lowerSanitized.includes(original.toLowerCase())) {
      return { valid: false, error: `Leaked sensitive value: "${original}" is still present in sanitized prompt.` };
    }
  }

  const originalProtected = findProtectedSpans(originalText);
  for (const span of originalProtected) {
    const hasSubspan = findRedactableSubspans(originalText, [span]).length > 0;
    if (!hasSubspan) {
      if (!sanitizedText.includes(span.value)) {
        return { valid: false, error: `Protected span "${span.value}" was modified or removed in the sanitized prompt.` };
      }
    }
  }

  const restored = restore(sanitizedText, sessionMap);
  for (const dummy of Object.keys(sessionMap)) {
    if (restored.includes(dummy)) {
      return { valid: false, error: `Restored text still contains dummy placeholder: ${dummy}` };
    }
  }

  return { valid: true };
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
    privacyModelText: privacyResponse ? privacyResponse.text : null,
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