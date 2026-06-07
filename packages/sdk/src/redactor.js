import { generateDummy } from "./dummy-data.js";

export function redact(text, detections) {
  const sessionMap = {};
  const typeCounts = {};
  const replacements = detections.map((detection) => {
    typeCounts[detection.type] = (typeCounts[detection.type] || 0) + 1;
    const dummy = generateDummy(detection.type, typeCounts[detection.type]);
    sessionMap[dummy] = detection.value;
    return { ...detection, replacement: dummy };
  });

  let sanitizedText = text;
  for (const detection of [...replacements].sort((a, b) => b.start - a.start)) {
    sanitizedText =
      sanitizedText.slice(0, detection.start) +
      detection.replacement +
      sanitizedText.slice(detection.end);
  }

  return {
    originalText: text,
    sanitizedText,
    detections: replacements,
    sessionMap
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