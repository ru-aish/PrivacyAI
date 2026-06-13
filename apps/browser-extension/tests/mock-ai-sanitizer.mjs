const PERSON_STANDINS = ["Alex Morgan", "Jordan Lee", "Sam Rivera", "Taylor Brooks"];
const ORG_STANDINS = ["Northwind Labs", "Acme Corporation", "Summit Analytics LLC"];

/**
 * Simulates a local privacy model — handles PII types regex-only pre-scrub cannot.
 * Uses distinct stand-ins (e.g. gsk_mock_ai_*) so tests can prove the AI path ran.
 */
export function mockAiSanitize(userMessage) {
  const sessionMap = {};
  let safePrompt = userMessage;
  const counters = { email: 0, phone: 0, person: 0, org: 0, apiKey: 0, ssn: 0 };

  const replaceAll = (text, search, replacement) => text.split(search).join(replacement);

  for (const match of userMessage.matchAll(/\bgsk_[A-Za-z0-9_]{6,}\b/g)) {
    counters.apiKey += 1;
    const dummy = `gsk_mock_ai_${counters.apiKey}_redacted`;
    sessionMap[dummy] = match[0];
    safePrompt = replaceAll(safePrompt, match[0], dummy);
  }

  for (const match of userMessage.matchAll(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]{6,}\b/g)) {
    counters.apiKey += 1;
    const dummy = `sk_mock_ai_${counters.apiKey}_redacted`;
    sessionMap[dummy] = match[0];
    safePrompt = replaceAll(safePrompt, match[0], dummy);
  }

  for (const match of userMessage.matchAll(/\b(?:I'm|I am|My name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g)) {
    counters.person += 1;
    const dummy = PERSON_STANDINS[(counters.person - 1) % PERSON_STANDINS.length];
    sessionMap[dummy] = match[1];
    safePrompt = replaceAll(safePrompt, match[1], dummy);
  }

  for (const match of userMessage.matchAll(/\b(?:work at|works at)\s+([A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,2}(?:\s+(?:Inc|LLC|Corp|Ltd))?)\b/g)) {
    counters.org += 1;
    const dummy = ORG_STANDINS[(counters.org - 1) % ORG_STANDINS.length];
    sessionMap[dummy] = match[1];
    safePrompt = replaceAll(safePrompt, match[1], dummy);
  }

  for (const match of userMessage.matchAll(/\(\d{3}\)\s*\d{3}-\d{4}/g)) {
    counters.phone += 1;
    const dummy = `+1 (555) 010-${String(counters.phone).padStart(4, "0")}`;
    sessionMap[dummy] = match[0];
    safePrompt = replaceAll(safePrompt, match[0], dummy);
  }

  for (const match of userMessage.matchAll(/\b\d{3}-\d{3}-\d{4}\b/g)) {
    counters.phone += 1;
    const dummy = `+1 (555) 010-${String(counters.phone).padStart(4, "0")}`;
    sessionMap[dummy] = match[0];
    safePrompt = replaceAll(safePrompt, match[0], dummy);
  }

  for (const match of userMessage.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) {
    counters.ssn += 1;
    const dummy = `000-00-${String(1000 + counters.ssn).slice(-4)}`;
    sessionMap[dummy] = match[0];
    safePrompt = replaceAll(safePrompt, match[0], dummy);
  }

  for (const match of userMessage.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    counters.email += 1;
    const dummy = `contact${counters.email}@example.com`;
    sessionMap[dummy] = match[0];
    safePrompt = replaceAll(safePrompt, match[0], dummy);
  }

  return {
    safe_prompt: safePrompt,
    session_map: sessionMap
  };
}