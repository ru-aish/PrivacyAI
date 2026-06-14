import { createDetectorPipeline } from "./detectors/index.js";
import { redact } from "./redactor.js";

export async function localSanitize(text) {
  const detector = createDetectorPipeline({ localDetectorEnabled: false });
  const detections = await detector.detect(text);
  return redact(text, detections);
}