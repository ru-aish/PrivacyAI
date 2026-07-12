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
      return PERSON_NAMES[(slot - 1) % PERSON_NAMES.length];
    case "ORGANIZATION":
      return ORGANIZATION_NAMES[(slot - 1) % ORGANIZATION_NAMES.length];
    case "LOCATION":
      return LOCATION_NAMES[(slot - 1) % LOCATION_NAMES.length];
    case "IP_ADDRESS":
      return `10.0.0.${slot}`;
    case "SSN":
      return `000-00-${String(1000 + slot).slice(-4)}`;
    case "CREDIT_CARD":
      return `4111 1111 1111 ${String(1000 + slot).slice(-4)}`;
    case "API_KEY":
      return `gsk_dummy_${slot}_redacted`;
    case "AWS_ACCESS_KEY":
      return `AKIADUMMY${String(slot).padStart(8, "0")}KEY`;
    case "ZIP":
      return `${String(10000 + slot).slice(-5)}`;
    case "URL_CREDENTIAL":
      return `credential_${slot}`;
    case "URL_QUERY_SECRET":
      return `redacted_secret_${slot}`;
    case "CONNECTION_STRING_CREDENTIAL":
      return `user${slot}`;
    case "MRN":
      return `MRN-${String(10000 + slot).slice(-5)}`;
    case "MEDICAL_ID":
      return `MEDICAL-ID-${slot}`;
    default:
      return `SensitiveValue${slot}`;
  }
}


const GENERATED_DUMMY_PATTERN_PARTS = [
  String.raw`contact\d+@example\.com`,
  String.raw`\+1 \(555\) 010-\d{4}`,
  String.raw`10\.0\.0\.\d+`,
  String.raw`000-00-\d{4}`,
  String.raw`4111 1111 1111 \d{4}`,
  String.raw`gsk_dummy_\d+_redacted`,
  String.raw`AKIADUMMY\d+KEY`,
  String.raw`credential_\d+`,
  String.raw`redacted_secret_\d+`,
  String.raw`user\d+`,
  String.raw`MRN-\d{5}`,
  String.raw`MEDICAL-ID-\d+`,
  String.raw`\b1\d{4}\b`,
  String.raw`SensitiveValue\d+`,
  ...PERSON_NAMES.map(escapeRegExp),
  ...ORGANIZATION_NAMES.map(escapeRegExp),
  ...LOCATION_NAMES.map(escapeRegExp)
];

export const GENERATED_DUMMY_PATTERN_SOURCE =
  `(?:${GENERATED_DUMMY_PATTERN_PARTS.join("|")})`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
