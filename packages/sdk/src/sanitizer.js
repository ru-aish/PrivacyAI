import { AiSanitizer } from "./ai-sanitizer.js";

export class PrivacySanitizer {
  constructor(options = {}) {
    this.sanitizer = options.sanitizer || new AiSanitizer(options);
  }

  async sanitize(text) {
    return this.sanitizer.sanitize(text);
  }
}