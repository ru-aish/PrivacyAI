import { createRedactionPlan, applyRedactionPlan } from "./redaction-plan.js";
import { decideRedactions } from "../policy/redaction-policy.js";

export function redact(text, detections, options = {}) {
  const filtered = decideRedactions(text, detections, options);
  const plan = createRedactionPlan(text, filtered);
  return {
    originalText: text,
    sanitizedText: applyRedactionPlan(text, plan),
    detections: plan.replacements,
    sessionMap: plan.sessionMap,
    privacySource: "local-regex"
  };
}
