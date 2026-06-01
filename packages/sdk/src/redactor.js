export function redact(text, detections) {
  const sessionMap = {};
  const typeCounts = {};
  const replacements = detections.map((detection) => {
    typeCounts[detection.type] = (typeCounts[detection.type] || 0) + 1;
    const placeholder = `[${detection.type}_${typeCounts[detection.type]}]`;
    sessionMap[placeholder] = detection.value;
    return { ...detection, replacement: placeholder };
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
  for (const [placeholder, value] of Object.entries(sessionMap)) {
    restored = restored.split(placeholder).join(value);
  }
  return restored;
}

