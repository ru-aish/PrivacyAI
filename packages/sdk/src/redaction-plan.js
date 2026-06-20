import { generateDummy } from "./dummy-data.js";

function countSessionMapTypes(sessionMap) {
  const counts = {};
  for (const dummy of Object.keys(sessionMap)) {
    const type = inferSecretTypeFromDummy(dummy);
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function inferSecretTypeFromDummy(dummy) {
  if (dummy.includes("@")) return "EMAIL";
  if (dummy.startsWith("+")) return "PHONE";
  if (dummy.startsWith("gsk_")) return "API_KEY";
  if (dummy.startsWith("AKIA")) return "AWS_ACCESS_KEY";
  if (dummy.startsWith("10.0.0.")) return "IP_ADDRESS";
  if (dummy.startsWith("000-")) return "SSN";
  if (dummy.startsWith("4111 ")) return "CREDIT_CARD";
  if (dummy.startsWith("https://example.com")) return "URL";
  if (/^\d{5}$/.test(dummy)) return "ZIP";
  return "API_KEY";
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

export function buildRedactionPlan(text, decisions, initialSessionMap = {}) {
  const sessionMap = { ...initialSessionMap };
  const typeCounts = countSessionMapTypes(sessionMap);

  const replacements = [];

  for (const decision of decisions) {
    const originalValue = decision.value;
    
    let dummy = Object.entries(sessionMap).find(([, o]) => o.toLowerCase() === originalValue.toLowerCase())?.[0];
    
    if (!dummy) {
      const type = decision.replacementType || decision.type || "API_KEY";
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      dummy = createUniqueDummy(type, typeCounts[type], text, sessionMap);
      sessionMap[dummy] = originalValue;
    }

    replacements.push({
      start: decision.start,
      end: decision.end,
      original: originalValue,
      replacement: dummy,
      type: decision.type,
      reason: decision.protectedParent ? `Subspan inside ${decision.protectedParent}` : `Detected ${decision.type}`
    });
  }

  return {
    originalText: text,
    replacements,
    sessionMap
  };
}

export function applyRedactionPlan(plan) {
  let sanitizedText = plan.originalText;
  
  const sortedReplacements = [...plan.replacements].sort((a, b) => b.start - a.start);
  
  for (const r of sortedReplacements) {
    sanitizedText =
      sanitizedText.slice(0, r.start) +
      r.replacement +
      sanitizedText.slice(r.end);
  }
  
  return sanitizedText;
}
