import { RedactionPlan, createRedactionPlan } from "./redaction-plan.js";

export function redact(text, detections) {
  const plan = createRedactionPlan(text, detections);
  return plan.toResult("local-regex");
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

export { RedactionPlan, createRedactionPlan } from "./redaction-plan.js";
