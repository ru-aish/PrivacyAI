import { RedactionPlan, createRedactionPlan } from "./redaction-plan.js";

export function redact(text, detections, options = {}) {
  const plan = createRedactionPlan(text, detections, options);
  return plan.toResult("local-regex");
}

export { restoreText as restore } from "./placeholder-transform.js";
export { RedactionPlan, createRedactionPlan } from "./redaction-plan.js";
