import { RegexDetector } from "./regex.js";
import { AiDetector } from "./ai.js";
import { resolveOverlaps } from "../policy/overlap-resolver.js";

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
  return resolveOverlaps(detections);
}

