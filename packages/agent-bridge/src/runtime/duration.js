const MAX_DURATION_MS = 30 * 60 * 1000;

export function resolvePositiveDuration(value, fallback, label) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > MAX_DURATION_MS) {
    throw new TypeError(`${label} must be an integer between 1 and ${MAX_DURATION_MS} milliseconds.`);
  }
  return normalized;
}
