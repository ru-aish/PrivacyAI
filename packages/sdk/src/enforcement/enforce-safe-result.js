import { generateDummy } from "../dummy-data.js";
import { decideRedactions } from "../policy/redaction-policy.js";
import { createRedactionPlan, applyRedactionPlan } from "../redaction/redaction-plan.js";

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

export function normalizeSessionMapCasing(originalText, sessionMap) {
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

export async function enforceSafeResult(originalText, parsed, detector) {
  parsed.session_map = normalizeSessionMapCasing(originalText, parsed.session_map);

  let sessionMap = fixSessionMapOrientation(originalText, parsed.safe_prompt, parsed.session_map);
  sessionMap = removeInvalidSessionMapEntries(originalText, sessionMap);

  // Track key replacements for vague stand-in keys
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

  // Apply vague key replacements to parsed.safe_prompt
  let safePromptBase = parsed.safe_prompt;
  for (const { oldKey, newKey } of keyReplacements) {
    const escaped = escapeRegExp(oldKey);
    const regex = new RegExp(escaped, "gi");
    safePromptBase = safePromptBase.replace(regex, newKey);
  }

  // 1. Get raw candidates from fallback detector
  const rawDetections = await detector.detect(originalText);

  // 2. Filter through policy rules
  const policyFilteredDetections = decideRedactions(originalText, rawDetections);

  // 3. Find missing detections that are leaked in safePromptBase
  const missing = policyFilteredDetections.filter((detection) => {
    return safePromptBase.toLowerCase().includes(detection.value.toLowerCase());
  });

  // 4. Create repair plan for missing detections
  const repairPlan = createRedactionPlan(originalText, missing, {
    sessionMap: sessionMap
  });

  // 5. Replace leaked values in safePromptBase
  let safePrompt = safePromptBase;
  const sortedReplacements = [...repairPlan.replacements].sort((a, b) => b.original.length - a.original.length);

  for (const r of sortedReplacements) {
    const escaped = escapeRegExp(r.original);
    const regex = new RegExp(escaped, "gi");
    safePrompt = safePrompt.replace(regex, r.replacement);
  }

  // Merge repair dummies into session map
  sessionMap = {
    ...sessionMap,
    ...repairPlan.sessionMap
  };

  // Determine if the LLM returned a mangled/invalid session map
  const llmMapKeys = Object.keys(parsed.session_map);
  const isMangledLlmMap = llmMapKeys.length > 0 && !llmMapKeys.some(key => {
    const val = parsed.session_map[key];
    return val && originalText.toLowerCase().includes(val.toLowerCase()) && key !== val;
  });

  if (isMangledLlmMap) {
    const fallbackPlan = createRedactionPlan(originalText, policyFilteredDetections);
    return {
      safe_prompt: applyRedactionPlan(originalText, fallbackPlan),
      session_map: fallbackPlan.sessionMap
    };
  }

  return {
    safe_prompt: safePrompt,
    session_map: sessionMap
  };
}

export function fixSessionMapOrientation(originalText, safePrompt, sessionMap) {
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

export function removeInvalidSessionMapEntries(originalText, sessionMap) {
  const cleaned = {};
  const lowerOriginal = originalText.toLowerCase();

  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (dummy === original) continue;
    if (!lowerOriginal.includes(original.toLowerCase())) continue;
    cleaned[dummy] = original;
  }

  return cleaned;
}

export function rebuildSafePrompt(originalText, sessionMap) {
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

export function countSessionMapTypes(sessionMap) {
  const counts = {};
  for (const original of Object.values(sessionMap)) {
    const type = inferSecretType(original);
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

export function findDummyForOriginal(sessionMap, original) {
  return Object.entries(sessionMap).find(([, value]) => value === original)?.[0];
}

export function createUniqueDummy(type, index, sourceText, sessionMap) {
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

export function isVagueStandIn(value) {
  return VAGUE_STANDINS.has(String(value).trim().toLowerCase());
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
