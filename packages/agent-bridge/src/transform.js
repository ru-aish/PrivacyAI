export {
  findUnresolvedPlaceholders,
  restoreText,
  restoreValue,
  sanitizeKnownText,
  sanitizeKnownValue,
  transformValue
} from "@privacy-ai/sdk";

export function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
