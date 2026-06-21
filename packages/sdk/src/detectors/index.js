import { RegexDetector } from "./regex.js";
import { AiDetector } from "./ai.js";

export class DetectorPipeline {
  constructor(detectors = [new RegexDetector()]) {
    this.detectors = detectors;
  }

  async detect(text) {
    const batches = await Promise.all(this.detectors.map((detector) => detector.detect(text)));
    return mergeDetections(batches.flat());
  }
}

export function createDetectorPipeline(options = {}) {
  const detectors = [new RegexDetector()];
  if (options.localDetectorEnabled && options.provider) {
    detectors.push(new AiDetector(options.provider, { model: options.localDetectorModel }));
  }
  return new DetectorPipeline(detectors);
}

export function mergeDetections(detections) {
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
      const PRECEDENCE = {
        "CONNECTION_STRING_CREDENTIAL": 100,
        "URL_QUERY_SECRET": 90,
        "URL_CREDENTIAL": 90,
        "API_KEY": 80,
        "EMAIL": 50,
        "IP_ADDRESS": 50
      };

      if (index !== -1) {
        const currentPrio = PRECEDENCE[merged[index].type] || merged[index].confidence * 10;
        const newPrio = PRECEDENCE[detection.type] || detection.confidence * 10;
        if (newPrio > currentPrio) {
        merged[index] = detection;
        }
      }
      return merged;
    }, [])
    .sort((a, b) => a.start - b.start);
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

