import { extractProtectedSpans, findRedactableSubspans } from "./policy/span-policy.js";
import { classifyDetections, shouldRedact } from "./policy/redaction-policy.js";
import { generateDummy } from "./dummy-data.js";

export class RedactionPlan {
  constructor(originalText) {
    this.originalText = originalText;
    this.replacements = [];
    this.sessionMap = {};
    this.protectedSpans = extractProtectedSpans(originalText);
  }

  addReplacement(start, end, original, replacement, type, reason) {
    this.replacements.push({
      start,
      end,
      original,
      replacement,
      type,
      reason
    });
    this.sessionMap[replacement] = original;
  }

  addDetections(detections) {
    const typeCounts = {};
    const classified = classifyDetections(detections, { text: this.originalText, protectedSpans: this.protectedSpans });

    for (const d of classified) {
      if (d.action !== "redact") continue;
      if (this.findReplacement(d.start, d.end)) continue;

      typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;
      const dummy = this.createUniqueDummy(d.type, typeCounts[d.type]);
      this.addReplacement(d.start, d.end, d.value, dummy, d.type, "detector");
    }
  }

  addProtectedSpanSubspans() {
    for (const span of this.protectedSpans) {
      const subspans = findRedactableSubspans(span, this.originalText);
      for (const sub of subspans) {
        if (this.findReplacement(sub.start, sub.end)) continue;
        const typeCount = this.countTypeInReplacements(sub.type);
        const dummy = this.createUniqueDummy("API_KEY", typeCount + 1);
        this.addReplacement(sub.start, sub.end, sub.value, dummy, sub.type, "policy");
      }
    }
  }

  apply() {
    let sanitized = this.originalText;
    const sorted = [...this.replacements].sort((a, b) => b.start - a.start);

    for (const r of sorted) {
      sanitized =
        sanitized.slice(0, r.start) +
        r.replacement +
        sanitized.slice(r.end);
    }

    return sanitized;
  }

  toResult(privacySource = "redaction-plan") {
    return {
      originalText: this.originalText,
      sanitizedText: this.apply(),
      sessionMap: { ...this.sessionMap },
      detections: this.replacements.map(r => ({
        type: r.type,
        value: r.original,
        start: r.start,
        end: r.end,
        confidence: 1.0,
        source: r.reason || privacySource,
        replacement: r.replacement
      })),
      privacySource
    };
  }

  ensureProtectedSpans(protectedSpans) {
    const credTypes = new Set(["URL_CREDENTIAL", "URL_QUERY_SECRET", "CONNECTION_STRING_CREDENTIAL", "SESSION_MAP_OVERRIDE"]);

    this.replacements = this.replacements.filter(r => {
      const inProtected = protectedSpans.some(span =>
        span.start <= r.start && span.end >= r.end
      );
      if (!inProtected) return true;
      return credTypes.has(r.type);
    });

    this.sessionMap = {};
    for (const r of this.replacements) {
      this.sessionMap[r.replacement] = r.original;
    }
  }

  findReplacement(start, end) {
    return this.replacements.find(r => r.start === start && r.end === end);
  }

  createUniqueDummy(type, index) {
    let dummy = generateDummy(type, index);
    let slot = index;
    const lowerSource = this.originalText.toLowerCase();

    while (lowerSource.includes(dummy.toLowerCase()) || Object.hasOwn(this.sessionMap, dummy)) {
      slot += 1;
      dummy = generateDummy(type, slot);
    }

    return dummy;
  }

  countTypeInReplacements(type) {
    return this.replacements.filter(r => r.type === type).length;
  }
}

export function createRedactionPlan(text, detections) {
  const plan = new RedactionPlan(text);
  plan.addProtectedSpanSubspans();
  plan.addDetections(detections);
  return plan;
}
