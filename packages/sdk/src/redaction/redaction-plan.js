import { generateDummy } from "../dummy-data.js";

export function createRedactionPlan(text, detections, options = {}) {
  const sessionMap = { ...(options.sessionMap || {}) };
  const typeCounts = {};
  const replacements = [];

  for (const detection of detections) {
    typeCounts[detection.type] = (typeCounts[detection.type] || 0) + 1;
    const replacement =
      detection.replacement ||
      generateDummy(detection.type, typeCounts[detection.type]);

    sessionMap[replacement] = detection.value;
    replacements.push({
      start: detection.start,
      end: detection.end,
      original: detection.value,
      replacement,
      type: detection.type,
      reason: detection.reason || detection.source || "detector"
    });
  }

  return { originalText: text, replacements, sessionMap };
}

export function applyRedactionPlan(text, plan) {
  let output = text;
  for (const r of [...plan.replacements].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, r.start) + r.replacement + output.slice(r.end);
  }
  return output;
}
