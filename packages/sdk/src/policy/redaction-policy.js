import { collectProtectedSpans, isInsideProtectedSpan } from "./protected-spans.js";
import { resolveOverlaps } from "./overlap-resolver.js";

export function decideRedactions(text, candidates, options = {}) {
  const protectedSpans = collectProtectedSpans(text);
  const decisions = [];

  for (const candidate of candidates) {
    const decision = classifyCandidate(text, candidate, protectedSpans, options);
    if (decision.action === "redact") {
      decisions.push(decision);
    }
  }

  return resolveOverlaps(decisions);
}

export function classifyCandidate(text, candidate, protectedSpans, options = {}) {
  let action = "redact";
  let reason = "ordinary-secret";

  // 1. URLs are preserved by default (prompt policy: copy URLs EXACTLY)
  if (candidate.type === "URL") {
    action = "keep";
    reason = "ordinary-url";
  }

  // 2. If candidate is inside technical/protected context (code fences, backticks, stack traces, etc.)
  // we only redact high-confidence credentials and PII. We do not redact heuristic candidates.
  const inside = isInsideProtectedSpan(candidate.start, candidate.end, protectedSpans);
  if (inside) {
    const highConfidenceTypes = ["API_KEY", "AWS_ACCESS_KEY", "CREDIT_CARD", "SSN", "EMAIL"];
    if (!highConfidenceTypes.includes(candidate.type)) {
      action = "keep";
      reason = "protected-technical-context";
    }
  }

  // 3. IP_ADDRESS: keep unless explicitly requested to redact IPs
  if (candidate.type === "IP_ADDRESS") {
    if (options.redactIPs) {
      action = "redact";
      reason = "ip-sensitive";
    } else {
      action = "keep";
      reason = "ip-technical-context";
    }
  }

  // 4. EMAIL: redact
  if (candidate.type === "EMAIL") {
    action = "redact";
    reason = "email";
  }

  // 5. Credentials: redact
  if (candidate.type === "API_KEY" || candidate.type === "AWS_ACCESS_KEY") {
    action = "redact";
    reason = "credential";
  }

  // 6. For heuristic fields (PERSON, ORGANIZATION, LOCATION), avoid false-positive technology names
  if (candidate.type === "PERSON" || candidate.type === "ORGANIZATION" || candidate.type === "LOCATION") {
    const lowercaseVal = candidate.value.toLowerCase();
    const techNames = [
      "github", "privacyai", "vite", "playwright", "chrome", "firefox", "ollama", "openai", "node", "bun", "pnpm", "npm",
      "react", "vue", "angular", "express", "fastify", "nextjs", "redis", "postgres", "mysql", "mongodb"
    ];
    if (techNames.some(tech => lowercaseVal.includes(tech))) {
      action = "keep";
      reason = "technical-technology-name";
    }
  }

  return {
    ...candidate,
    action,
    reason
  };
}
