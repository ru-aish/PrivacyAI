import { extractProtectedSpans, findRedactableSubspans } from "./policy/span-policy.js";
import { classifyDetections, shouldRedact } from "./policy/redaction-policy.js";
import { allocateUniqueDummy, generateDummy } from "./dummy-data.js";

export class RedactionPlan {
  constructor(originalText, options = {}) {
    this.originalText = originalText;
    this.replacements = [];
    this.sessionMap = {};
    this.identity = options.identity;
    this.identityDomain = options.identityDomain || "text";
    this.protectedSpans = extractProtectedSpans(originalText);
  }

  addReplacement(start, end, original, replacement, type, reason) {
    const identity = this.identity?.placeholder?.(replacement, original, {
      category: type,
      domain: this.identityDomain
    });
    this.replacements.push({
      start,
      end,
      original,
      replacement,
      type,
      reason,
      ...(identity ? { identity } : {})
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
    const categoryByAlias = new Map();
    const canonicalByAlias = new Map();
    for (const replacement of this.replacements) {
      if (!categoryByAlias.has(replacement.replacement)) {
        categoryByAlias.set(replacement.replacement, replacement.type);
      }
      if (this.identity?.canonicalPlaceholder && !canonicalByAlias.has(replacement.replacement)) {
        canonicalByAlias.set(
          replacement.replacement,
          this.identity.canonicalPlaceholder(replacement.original, {
            category: categoryByAlias.get(replacement.replacement),
            domain: this.identityDomain
          })
        );
      }
    }
    const rawSanitizedText = this.apply();
    const canonical = this.identity?.canonicalizeAliases?.(
      rawSanitizedText,
      this.sessionMap,
      {
        domain: this.identityDomain,
        categoryForAlias: alias => categoryByAlias.get(alias)
      }
    );
    const sessionMap = canonical?.sessionMap || { ...this.sessionMap };
    const identityMap = canonical?.identityMap || this.identity?.describeSessionMap?.(sessionMap, {
      domain: this.identityDomain
    });
    return {
      originalText: this.originalText,
      sanitizedText: canonical?.sanitizedText ?? rawSanitizedText,
      sessionMap,
      ...(identityMap ? {
        identity: {
          version: this.identity.version,
          keyId: this.identity.keyId,
          scope: this.identity.scope
        },
        identityMap
      } : {}),
      detections: this.replacements.map(replacement => {
        const canonicalIdentity = canonicalByAlias.get(replacement.replacement) || replacement.identity;
        return {
          type: replacement.type,
          value: replacement.original,
          start: replacement.start,
          end: replacement.end,
          confidence: 1.0,
          source: replacement.reason || privacySource,
          replacement: canonicalIdentity?.alias || replacement.replacement,
          ...(canonicalIdentity ? { identity: canonicalIdentity } : {})
        };
      }),
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
    const lowerSource = this.originalText.toLowerCase();
    return allocateUniqueDummy(
      type,
      index,
      dummy => lowerSource.includes(dummy.toLowerCase()) || Object.hasOwn(this.sessionMap, dummy)
    );
  }

  countTypeInReplacements(type) {
    return this.replacements.filter(r => r.type === type).length;
  }
}

export function createRedactionPlan(text, detections, options = {}) {
  const plan = new RedactionPlan(text, options);
  plan.addProtectedSpanSubspans();
  plan.addDetections(detections);
  return plan;
}
