const PERSON_NAMES = [
  "Alex Morgan",
  "Jordan Lee",
  "Sam Rivera",
  "Taylor Brooks",
  "Casey Nguyen",
  "Riley Patel",
  "Morgan Chen",
  "Avery Scott"
];

const ORGANIZATION_NAMES = [
  "Northwind Labs",
  "Acme Corporation",
  "Blue Harbor Inc",
  "Summit Analytics LLC",
  "Harborview Systems",
  "Cedar Ridge Bank",
  "Lumen Health Group"
];

const LOCATION_NAMES = [
  "Springfield",
  "Riverdale",
  "Fairview",
  "Brookfield",
  "Ashford",
  "Lakeside",
  "Greenville"
];

export function generateDummy(type, index = 1) {
  const slot = Math.max(1, index);

  switch (type) {
    case "EMAIL":
      return `contact${slot}@example.com`;
    case "PHONE":
      return `+1 (555) 010-${String(slot).padStart(4, "0")}`;
    case "PERSON":
      return pooledDummy(PERSON_NAMES, "Person", slot);
    case "ORGANIZATION":
      return pooledDummy(ORGANIZATION_NAMES, "Organization", slot);
    case "LOCATION":
      return pooledDummy(LOCATION_NAMES, "Location", slot);
    case "IP_ADDRESS":
      return `10.0.0.${slot}`;
    case "SSN":
      return `000-00-${String(1000 + slot).padStart(4, "0")}`;
    case "CREDIT_CARD":
      return `4111 1111 1111 ${String(1000 + slot).padStart(4, "0")}`;
    case "API_KEY":
      return `gsk_dummy_${slot}_redacted`;
    case "AWS_ACCESS_KEY":
      return `AKIADUMMY${String(slot).padStart(8, "0")}KEY`;
    case "ZIP":
    case "POSTAL_CODE":
      return `ZIP-${String(10000 + slot).padStart(5, "0")}`;
    case "URL_CREDENTIAL":
      return `credential_${slot}`;
    case "URL_QUERY_SECRET":
      return `redacted_secret_${slot}`;
    case "CONNECTION_STRING_CREDENTIAL":
      return `user${slot}`;
    case "MRN":
      return `MRN-${String(10000 + slot).padStart(5, "0")}`;
    case "MEDICAL_ID":
      return `MEDICAL-ID-${slot}`;
    default:
      return `SensitiveValue${slot}`;
  }
}

export function allocateUniqueDummy(type, index, isUnavailable, options = {}) {
  if (typeof isUnavailable !== "function") {
    throw new TypeError("allocateUniqueDummy requires an availability predicate.");
  }

  const maxAttempts = options.maxAttempts ?? 1024;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new TypeError("allocateUniqueDummy maxAttempts must be a positive safe integer.");
  }

  let slot = Math.max(1, Number.isFinite(index) ? Math.floor(index) : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1, slot += 1) {
    const candidate = generateDummy(type, slot);
    if (!isUnavailable(candidate)) return candidate;
  }

  const error = new Error("PrivacyAI could not allocate a collision-free dummy value.");
  error.code = "PRIVACYAI_DUMMY_ALLOCATION_EXHAUSTED";
  throw error;
}

function pooledDummy(values, fallbackLabel, slot) {
  if (slot <= values.length) return values[slot - 1];
  return `${fallbackLabel} ${slot}`;
}

const GENERATED_DUMMY_PATTERN_PARTS = [
  String.raw`contact\d+@example\.com`,
  String.raw`\+1 \(555\) 010-\d{4,}`,
  String.raw`10\.0\.0\.\d+`,
  String.raw`000-00-\d{4,}`,
  String.raw`4111 1111 1111 \d{4,}`,
  String.raw`gsk_dummy_\d+_redacted`,
  String.raw`AKIADUMMY\d+KEY`,
  String.raw`credential_\d+`,
  String.raw`redacted_secret_\d+`,
  String.raw`user\d+`,
  String.raw`MRN-\d{5,}`,
  String.raw`MEDICAL-ID-\d+`,
  String.raw`ZIP-\d{5,}`,
  String.raw`SensitiveValue\d+`,
  String.raw`Person \d+`,
  String.raw`Organization \d+`,
  String.raw`Location \d+`,
  ...PERSON_NAMES.map(escapeRegExp),
  ...ORGANIZATION_NAMES.map(escapeRegExp),
  ...LOCATION_NAMES.map(escapeRegExp)
];

export const GENERATED_DUMMY_PATTERN_SOURCE =
  `(?:${GENERATED_DUMMY_PATTERN_PARTS.join("|")})`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
