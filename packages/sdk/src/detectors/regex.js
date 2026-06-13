const PATTERNS = [
  {
    type: "EMAIL",
    confidence: 0.99,
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  },
  {
    type: "URL",
    confidence: 0.95,
    regex: /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"']+/gi
  },
  {
    type: "IP_ADDRESS",
    confidence: 0.95,
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
  },
  {
    type: "SSN",
    confidence: 0.98,
    regex: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g
  },
  {
    type: "CREDIT_CARD",
    confidence: 0.9,
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (value) => luhnLike(value)
  },
  {
    type: "PHONE",
    confidence: 0.85,
    regex: /(?:\+\d{1,3}[-.\s()]*)?(?:\(?\d{2,5}\)?[-.\s()]*){1,3}\d{4}\b/g
  },
  {
    type: "PHONE",
    confidence: 0.82,
    regex: /\b\d{3}[-.]\d{4}\b/g
  },
  {
    type: "API_KEY",
    confidence: 0.93,
    regex: /\bgsk_[A-Za-z0-9]{20,}\b/g
  },
  {
    type: "API_KEY",
    confidence: 0.92,
    regex: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]{8,}\b/g
  },
  {
    type: "API_KEY",
    confidence: 0.9,
    regex: /\bapi\s*:?\s*([a-f0-9]{32,64})\b/gi,
    valueGroup: 1
  },
  {
    type: "API_KEY",
    confidence: 0.88,
    regex: /\bapi\s*key\b[^.\n]{0,60}?\b([a-f0-9]{32,64})\b/gi,
    valueGroup: 1
  },
  {
    type: "AWS_ACCESS_KEY",
    confidence: 0.95,
    regex: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|AIPA)[A-Z0-9]{12,20}\b/g
  },
  {
    type: "API_KEY",
    confidence: 0.88,
    regex: /\b(?:sk|pk|rk|xox[baprs]-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{8,}\b/g
  },
  {
    type: "API_KEY",
    confidence: 0.8,
    regex: /\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token)[:\s=]+['"]?([A-Za-z0-9_\-./+=]{12,})['"]?/gi,
    valueGroup: 1
  },
  {
    type: "API_KEY",
    confidence: 0.8,
    regex: /\b(?:sk|pk|api|key|token|secret)[-_]?[A-Za-z0-9]{16,}\b/g
  }
];

const ORG_REGEX = /\b([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}\s+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Labs|Systems|Bank|Hospital|University))\b/g;
const PERSON_REGEX = /\b(?:Dr\.?\s+|Prof\.?\s+|Mr\.?\s+|Ms\.?\s+|Mrs\.?\s+)?([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+(?:Jr\.?|Sr\.?|III|IV))?)\b/g;
const CONTACT_PERSON_REGEX = /\bContact\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)+)\s+at\b/g;
const CONTEXT_NAME_REGEX = /\b(?:my name is\s+|name['"]?\s*:\s*['"]?)([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)+?)(?=[,'".}]|\s+(?:and|my|with|at|from|in)\b|$)/gi;
const CONTEXT_COMPANY_REGEX = /\b(?:company['"]?\s*:\s*['"]?|my company is\s+)([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3}?)(?=[,'".}]|\s+(?:and|my|with|at)\b|$)/gi;
const CONTEXT_CITY_REGEX = /\b(?:city['"]?\s*:\s*['"]|live in\s+|located in\s+)([A-Z][A-Za-z .'-]+?)(?=[,'".}]|\s+(?:and|my|with|at)\b|$)/gi;
const CONTEXT_ZIP_REGEX = /\bzip['"]?\s*:\s*['"]?(\d{5}(?:-\d{4})?)/gi;
const COMMON_LOCATION_REGEX = /\b(New York|Berlin|Boston|San Francisco|Seattle|London|Paris|Mumbai|Delhi|Bengaluru|Tokyo)\b/g;

export class RegexDetector {
  detect(text) {
    const detections = [];
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern.regex)) {
        const value = pattern.valueGroup ? match[pattern.valueGroup] : match[0];
        if (!value) continue;
        const start = pattern.valueGroup ? match.index + match[0].indexOf(value) : match.index;
        if (pattern.validate && !pattern.validate(value)) continue;
        detections.push(toDetection(pattern.type, value, start, pattern.confidence, "regex"));
      }
    }

    for (const match of text.matchAll(ORG_REGEX)) {
      detections.push(toDetection("ORGANIZATION", match[1], match.index, 0.72, "heuristic"));
    }

    addCapturedMatches(detections, text, CONTACT_PERSON_REGEX, "PERSON", 0.9, "context");
    addCapturedMatches(detections, text, CONTEXT_NAME_REGEX, "PERSON", 0.9, "context");
    addCapturedMatches(detections, text, CONTEXT_COMPANY_REGEX, "ORGANIZATION", 0.86, "context");
    addCapturedMatches(detections, text, CONTEXT_CITY_REGEX, "LOCATION", 0.86, "context");
    addCapturedMatches(detections, text, CONTEXT_ZIP_REGEX, "POSTAL_CODE", 0.86, "context");
    addFullMatches(detections, text, COMMON_LOCATION_REGEX, "LOCATION", 0.84, "context");

    for (const match of text.matchAll(PERSON_REGEX)) {
      const offset = match[0].indexOf(match[1]);
      if (!isLikelyFalsePerson(match[1])) {
        detections.push(toDetection("PERSON", match[1], match.index + offset, 0.68, "heuristic"));
      }
    }

    return detections;
  }
}

function addCapturedMatches(detections, text, regex, type, confidence, source) {
  for (const match of text.matchAll(regex)) {
    const rawValue = match[1];
    const value = rawValue.trim().replace(/['"’]+$/g, "");
    const offset = match[0].indexOf(match[1]);
    detections.push(toDetection(type, value, match.index + offset, confidence, source));
  }
}

function addFullMatches(detections, text, regex, type, confidence, source) {
  for (const match of text.matchAll(regex)) {
    detections.push(toDetection(type, match[0], match.index, confidence, source));
  }
}

function toDetection(type, value, start, confidence, source) {
  return {
    type,
    value,
    start,
    end: start + value.length,
    confidence,
    source
  };
}

function isLikelyFalsePerson(value) {
  const firstWord = value.split(/\s+/)[0];
  return ["Contact", "Please", "Return", "Write", "Replace"].includes(firstWord);
}

function luhnLike(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}
