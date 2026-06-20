import { extractProtectedSpans, findProtectedSpan, findRedactableSubspans } from "./span-policy.js";

const PRIVATE_IP_REGEX = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/;

const SENSITIVE_TYPES = new Set([
  "EMAIL", "SSN", "CREDIT_CARD", "PHONE", "API_KEY", "AWS_ACCESS_KEY",
  "URL_CREDENTIAL", "URL_QUERY_SECRET", "CONNECTION_STRING_CREDENTIAL",
  "MEDICAL_ID", "MRN"
]);

const HIGH_CONFIDENCE_THRESHOLD = 0.9;

const PUBLIC_TECHNICAL_TERMS = new Set([
  "React", "Gemini", "OAuth", "TypeScript", "PrivacyAI", "GitHub",
  "Kubernetes", "Terraform", "Node", "Python", "Docker", "Linux",
  "macOS", "Windows", "JavaScript", "TypeScript", "HTML", "CSS",
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "RabbitMQ",
  "GraphQL", "REST", "API", "SDK", "CLI", "JSON", "XML", "YAML",
  "npm", "yarn", "pnpm", "pip", "conda", "git", "ssh", "http",
  "localhost", "CORS", "JWT", "OIDC", "SAML", "LDAP"
]);

export function shouldRedact(detection, { text, protectedSpans } = {}) {
  if (!protectedSpans) {
    protectedSpans = text ? extractProtectedSpans(text) : [];
  }

  if (!detection || !detection.value) return false;

  if (PUBLIC_TECHNICAL_TERMS.has(detection.value.trim())) {
    return false;
  }

  const parentSpan = findProtectedSpan(protectedSpans, detection.start, detection.end);

  if (parentSpan) {
    if (detection.type === "URL" || detection.type === "CONNECTION_STRING" ||
        detection.type === "FILE_PATH" || detection.type === "CODE_BLOCK" ||
        detection.type === "INLINE_CODE") {
      return false;
    }

    if (detection.type === "URL_CREDENTIAL" || detection.type === "URL_QUERY_SECRET" ||
        detection.type === "CONNECTION_STRING_CREDENTIAL") {
      return true;
    }

    if (parentSpan.type === "URL" || parentSpan.type === "CONNECTION_STRING") {
      const subspans = findRedactableSubspans(parentSpan, null);
      const matching = subspans.find(s => s.start === detection.start && s.end === detection.end);
      if (matching) return matching.action === "redact";
    }

    return false;
  }

  if (SENSITIVE_TYPES.has(detection.type)) {
    return true;
  }

  if (detection.type === "IP_ADDRESS") {
    if (detection.confidence >= HIGH_CONFIDENCE_THRESHOLD && !PRIVATE_IP_REGEX.test(detection.value)) {
      return true;
    }
    return false;
  }

  if (detection.type === "PERSON" || detection.type === "ORGANIZATION" ||
      detection.type === "LOCATION") {
    if (detection.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      return true;
    }
    return false;
  }

  if (detection.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return true;
  }

  return false;
}

export function classifyDetections(detections, options = {}) {
  const text = options.text;
  const protectedSpans = text ? extractProtectedSpans(text) : (options.protectedSpans || []);

  return detections.map(d => ({
    ...d,
    action: shouldRedact(d, { text, protectedSpans }) ? "redact" : "keep"
  }));
}

export { extractProtectedSpans, findProtectedSpan, findRedactableSubspans } from "./span-policy.js";
