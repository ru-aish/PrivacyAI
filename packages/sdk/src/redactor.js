import { createRedactionPlan, applyRedactionPlan } from "./redaction/redaction-plan.js";

export function redact(text, detections) {
  const plan = createRedactionPlan(text, detections);
  return {
    originalText: text,
    sanitizedText: applyRedactionPlan(text, plan),
    detections: plan.replacements,
    sessionMap: plan.sessionMap,
    privacySource: "local-regex"
  };
}

export function restore(text, sessionMap) {
  let restored = text;
  const replacements = Object.entries(sessionMap).sort(
    ([left], [right]) => right.length - left.length
  );

  for (const [dummy, value] of replacements) {
    restored = restored.split(dummy).join(value);
  }

  return restored;
}