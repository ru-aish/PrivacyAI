import { RedactionPlan, createRedactionPlan } from "./redaction-plan.js";

export function redact(text, detections) {
  const plan = createRedactionPlan(text, detections);
  return plan.toResult("local-regex");
}

export function restore(text, sessionMap) {
  if (typeof text !== "string") return text;
  const replacements = Object.entries(sessionMap || {}).sort(
    ([left], [right]) => right.length - left.length
  );
  if (replacements.length === 0) return text;

  // Restore against the provider output in one pass. A restored original may
  // legitimately contain text that looks like another placeholder; rescanning
  // replacement values would corrupt that literal text and make round-trips
  // depend on placeholder lengths.
  const values = new Map(replacements);
  const pattern = new RegExp(
    replacements.map(([dummy]) => escapeRegExp(dummy)).join("|"),
    "g"
  );
  return text.replace(pattern, dummy => values.get(dummy));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { RedactionPlan, createRedactionPlan } from "./redaction-plan.js";
