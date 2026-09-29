import { createDetectorPipeline } from "./detectors/index.js";
import { redact } from "./redactor.js";

export async function localSanitize(text, options = {}) {
  const detector = createDetectorPipeline({ localDetectorEnabled: false });
  const detections = await detector.detect(text);
  return redact(text, detections, options);
}