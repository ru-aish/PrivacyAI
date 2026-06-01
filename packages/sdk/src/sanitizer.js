import { createDetectorPipeline } from "./detectors/index.js";
import { redact } from "./redactor.js";

export class PrivacySanitizer {
  constructor(options = {}) {
    this.detector = options.detector || createDetectorPipeline(options);
  }

  async sanitize(text) {
    if (typeof text !== "string") {
      throw new TypeError("PrivacySanitizer.sanitize expects a string prompt.");
    }

    const detections = await this.detector.detect(text);
    return redact(text, detections);
  }
}

