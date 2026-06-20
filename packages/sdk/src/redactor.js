import { classifyDetections } from "./policy/redaction-policy.js";
import { buildRedactionPlan, applyRedactionPlan } from "./redaction-plan.js";

export function redact(text, detections, options = {}) {
  const decisions = classifyDetections(text, detections, options);
  const plan = buildRedactionPlan(text, decisions);
  const sanitizedText = applyRedactionPlan(plan);

  const formattedDetections = plan.replacements.map((r) => ({
    type: r.type,
    value: r.original,
    start: r.start,
    end: r.end,
    confidence: 0.9,
    source: "local-regex",
    replacement: r.replacement
  }));

  return {
    originalText: text,
    sanitizedText,
    detections: formattedDetections,
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