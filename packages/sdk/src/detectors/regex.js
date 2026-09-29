const PATTERNS = [
  {
    type: "EMAIL",
    confidence: 0.99,
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
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
    confidence: 0.94,
    regex: /(?<![\dA-Za-z])\+\d{1,3}(?:[\s.-]?\d){8,14}(?!\d)/g
  },
  {
    type: "PHONE",
    confidence: 0.88,
    regex: /\b[6-9]\d{4}[\s.-]?\d{5}\b/g
  },
  {
    type: "PHONE",
    confidence: 0.85,
    regex: /(?:\+\d{1,3}[-.\s()]*)?(?:\(?\d{2,5}\)?[-.\s()]*){1,3}\d{4}\b/g,
    validate: (value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15;
    }
  },
  {
    type: "PHONE",
    confidence: 0.82,
    regex: /\b(?:phone|tel|telephone|mobile)\s*[:=]?\s*(\d{3}[-.]\d{4})\b/gi,
    valueGroup: 1
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
  },
  {
    type: "API_KEY",
    confidence: 0.75,
    regex: /\bsecret\s+is\s+([A-Za-z0-9_-]{8,})/gi,
    valueGroup: 1
  },
  {
    type: "URL_CREDENTIAL",
    confidence: 0.97,
    regex: /(?:https?:\/\/|ftp:\/\/)(?:[^@\/\s]+):([^@\/\s]+)@/g,
    valueGroup: 1
  },
  {
    type: "URL_QUERY_SECRET",
    confidence: 0.95,
    regex: /[?&](?:token|access_token|api_key|signature|password|secret|sig|code)=([^&\s"]{8,})/gi,
    valueGroup: 1
  },
  {
    type: "CONNECTION_STRING_CREDENTIAL",
    confidence: 0.96,
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|kafka):\/\/([^:\/\s]+):([^@\/\s]+)@/g,
    valueGroup: 1
  },
  {
    type: "CONNECTION_STRING_CREDENTIAL",
    confidence: 0.96,
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|kafka):\/\/(?:[^:\/\s]+):([^@\/\s]+)@/g,
    valueGroup: 1
  },
  {
    type: "CONNECTION_STRING_CREDENTIAL",
    confidence: 0.95,
    regex: /\bredis:\/\/:([^@\/\s]+)@/g,
    valueGroup: 1
  },
  {
    type: "MRN",
    confidence: 0.97,
    regex: /\bMRN[-\s]?\d{5,}\b/gi
  },
  {
    type: "MEDICAL_ID",
    confidence: 0.94,
    regex: /\bPatient\s+ID[:\s]+([A-Z0-9]{4,})/gi,
    valueGroup: 1
  },
  {
    type: "MEDICAL_ID",
    confidence: 0.93,
    regex: /\b(?:Insurance|Member)\s+ID[:\s]+([A-Z0-9]{4,})/gi,
    valueGroup: 1
  }
];

const ORG_REGEX = /\b([A-Z][A-Za-z0-9&.'-]*(?:[ \t]+[A-Z][A-Za-z0-9&.'-]*){0,4}[ \t]+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Labs|Systems|Bank|Hospital|University))\b/g;
const PERSON_REGEX = /\b(?:Dr\.?[ \t]+|Prof\.?[ \t]+|Mr\.?[ \t]+|Ms\.?[ \t]+|Mrs\.?[ \t]+)?([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?[ \t]+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:[ \t]+(?:Jr\.?|Sr\.?|III|IV))?)\b/g;
const CONTACT_PERSON_REGEX = /\bContact[ \t]+([A-Z][A-Za-z'’-]+(?:[ \t]+[A-Z][A-Za-z'’-]+)+)[ \t]+at\b/g;
const CONTEXT_NAME_REGEX = /\b(?:my name is[ \t]+|name['"]?[ \t]*:[ \t]*['"]?)([A-Z][A-Za-z'’-]+(?:[ \t]+[A-Z][A-Za-z'’-]+)+?)(?=[,'".}]|[ \t]+(?:and|my|with|at|from|in)\b|$)/gi;
const CONTEXT_PATIENT_REGEX = /\b(?:patient|customer|employee)[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+?)(?=[,'".}]|[ \t]+(?:reported|said|has|is|was)\b|$)/gi;
const CONTEXT_COMPANY_REGEX = /\b(?:company['"]?[ \t]*:[ \t]*['"]?|my company is[ \t]+)([A-Z][A-Za-z0-9&.'-]*(?:[ \t]+[A-Z][A-Za-z0-9&.'-]*){0,3}?)(?=[,'".}]|[ \t]+(?:and|my|with|at)\b|$)/gi;
const CONTEXT_CITY_REGEX = /\b(?:city['"]?[ \t]*:[ \t]*['"]|live in[ \t]+|located in[ \t]+)([A-Z][A-Za-z .'-]+?)(?=[,'".}]|[ \t]+(?:and|my|with|at)\b|$)/gi;
const CONTEXT_ZIP_REGEX = /\bzip['"]?\s*:\s*['"]?(\d{5}(?:-\d{4})?)/gi;
const COMMON_LOCATION_REGEX = /\b(New York|Berlin|Boston|San Francisco|Seattle|London|Paris|Mumbai|Delhi|Bengaluru|Tokyo)\b/g;
const CONTEXT_NAME_DOB_REGEX = /\b(?:name|DOB)[ \t]*:[ \t]*([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)\b/g;

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
    addCapturedMatches(detections, text, CONTEXT_PATIENT_REGEX, "PERSON", 0.85, "context");
    addCapturedMatches(detections, text, CONTEXT_COMPANY_REGEX, "ORGANIZATION", 0.86, "context");
    addCapturedMatches(detections, text, CONTEXT_CITY_REGEX, "LOCATION", 0.86, "context");
    addCapturedMatches(detections, text, CONTEXT_ZIP_REGEX, "POSTAL_CODE", 0.86, "context");
    addCapturedMatches(detections, text, CONTEXT_NAME_DOB_REGEX, "PERSON", 0.82, "context");
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

const KNOWN_NON_PERSON_TERMS = new Set([
  "TypeScript", "JavaScript", "GitHub", "GitLab", "React", "Angular",
  "Docker", "Kubernetes", "Contact", "Please", "Return", "Write", "Replace",
  "Using", "Running", "Getting", "Having", "Making", "Going"
]);

function isLikelyFalsePerson(value) {
  const firstWord = value.split(/\s+/)[0];
  if (KNOWN_NON_PERSON_TERMS.has(firstWord)) return true;
  if (KNOWN_NON_PERSON_TERMS.has(value)) return true;
  return false;
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
