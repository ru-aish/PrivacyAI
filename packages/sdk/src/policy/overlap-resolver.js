export function resolveOverlaps(detections) {
  return detections
    .filter((detection) => detection && detection.value && Number.isInteger(detection.start))
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return b.end - b.start - (a.end - a.start);
    })
    .reduce((merged, detection) => {
      const overlaps = merged.some((current) => rangesOverlap(current, detection));
      if (!overlaps) {
        merged.push(detection);
        return merged;
      }

      const index = merged.findIndex((current) => rangesOverlap(current, detection));
      if (index !== -1 && detection.confidence > merged[index].confidence) {
        merged[index] = detection;
      }
      return merged;
    }, [])
    .sort((a, b) => a.start - b.start);
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}
