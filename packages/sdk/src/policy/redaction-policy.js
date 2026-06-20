import { findProtectedSpans, findRedactableSubspans } from "./protected-spans.js";

export function isPrivateIp(ip) {
  if (ip === "localhost" || ip === "127.0.0.1" || ip === "::1") return true;
  const parts = ip.split(".");
  if (parts.length === 4) {
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true;
    if (first === 127) return true;
  }
  return false;
}

export function classifyDetections(text, candidates, options = {}) {
  const protectedSpans = findProtectedSpans(text);
  const redactableSubspans = findRedactableSubspans(text, protectedSpans);

  const decisions = [];

  // Filter and process candidate detections
  for (const candidate of candidates) {
    // We handle URL redaction via protected spans and subspans
    if (candidate.type === "URL") {
      continue;
    }

    const parentSpan = protectedSpans.find(
      (p) => candidate.start >= p.start && candidate.end <= p.end
    );

    if (parentSpan) {
      // Candidate is inside a protected span
      if (candidate.type === "API_KEY" || candidate.type === "AWS_ACCESS_KEY") {
        decisions.push({
          type: candidate.type,
          value: candidate.value,
          start: candidate.start,
          end: candidate.end,
          action: "redact",
          replacementType: candidate.type,
          confidence: candidate.confidence,
          source: candidate.source
        });
      }
      // Otherwise, we discard candidate detections inside protected spans to preserve context
      continue;
    }

    // Candidate is outside any protected span
    if (candidate.type === "IP_ADDRESS") {
      const keepPrivate = options.keepPrivateIp !== false;
      if (keepPrivate && isPrivateIp(candidate.value)) {
        continue; // Keep private IP
      }
    }

    decisions.push({
      type: candidate.type,
      value: candidate.value,
      start: candidate.start,
      end: candidate.end,
      action: "redact",
      replacementType: candidate.type,
      confidence: candidate.confidence,
      source: candidate.source
    });
  }

  // Add the redactable subspans
  for (const sub of redactableSubspans) {
    decisions.push({
      type: sub.type,
      value: sub.value,
      start: sub.start,
      end: sub.end,
      action: sub.action,
      replacementType: sub.replacementType,
      protectedParent: sub.protectedParent,
      confidence: 0.95,
      source: "policy-engine"
    });
  }

  // Deduplicate and resolve overlaps among decisions
  return resolveDecisionOverlaps(decisions);
}

function resolveDecisionOverlaps(decisions) {
  if (decisions.length === 0) return [];

  // Sort by start position, then by length descending
  const sorted = [...decisions].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });

  const resolved = [];
  for (const decision of sorted) {
    const overlaps = resolved.some((current) => rangesOverlap(current, decision));
    if (!overlaps) {
      resolved.push(decision);
      continue;
    }

    const index = resolved.findIndex((current) => rangesOverlap(current, decision));
    if (index !== -1) {
      // Keep the one with higher confidence, or longer length if confidence is same
      const current = resolved[index];
      const decConf = decision.confidence || 0.5;
      const curConf = current.confidence || 0.5;
      if (decConf > curConf) {
        resolved[index] = decision;
      } else if (decConf === curConf) {
        const decLen = decision.end - decision.start;
        const curLen = current.end - current.start;
        if (decLen > curLen) {
          resolved[index] = decision;
        }
      }
    }
  }

  return resolved.sort((a, b) => a.start - b.start);
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}
