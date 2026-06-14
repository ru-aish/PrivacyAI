import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServers, stopTestServers, getLastApiRequest } from "./test-servers.mjs";
import { mockAiSanitize } from "./mock-ai-sanitizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "../dist");

const COMPLEX_SCENARIOS = [
  "I'm Eleanor Vance, call me at 415-555-9821. Groq API key: gsk_live_secret_xyz99",
  "I work at Harborview Systems. SSN 482-91-3307. Email priya.k@corp.net for follow-up.",
  "I'm Marcus Chen. I work at Summit Analytics LLC. Phone (212) 555-4419. Key sk_test_billing_88aa01"
];

function buildVariedPrompt(seed) {
  const names = ["Sofia Alvarez", "Priya Kapoor", "Derek Whitman", "Amara Okafor"];
  const phones = ["628-444-1098", "773-555-8820", "305-555-7124"];
  const keys = ["gsk_prod_7f2a9c1b", "gsk_user_auth_44ef12", "gsk_deploy_key_9x1"];
  const pick = (arr) => arr[seed % arr.length];

  const name = pick(names);
  const phone = pick(phones);
  const key = pick(keys);
  const prompt = `Please help me debug billing. I'm ${name}, phone ${phone}, credential ${key}.`;

  return { prompt, expected: mockAiSanitize(prompt), originals: [name, phone, key] };
}

async function waitForServiceWorker(context) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const workers = context.serviceWorkers();
    if (workers.length > 0) return workers[0];
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return context.waitForEvent("serviceworker", { timeout: 5000 });
}

async function configureExtension(context, apiPort) {
  const page = await context.newPage();
  await page.goto("about:blank");
  const serviceWorker = await waitForServiceWorker(context);
  await serviceWorker.evaluate((port) => chrome.storage.local.set({
    shieldEnabled: true,
    provider: "openai-compatible",
    model: "test-model",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key"
  }), apiPort);
  await page.close();
}

async function runPromptTest(page, prompt) {
  const expected = mockAiSanitize(prompt);
  const originals = Object.values(expected.session_map);
  const standins = Object.keys(expected.session_map);
  const logs = [];
  page.on("console", (msg) => logs.push(msg.text()));

  const promptInput = page.locator("#prompt-input");
  await promptInput.fill(prompt);

  const editorValueBeforeSubmit = await promptInput.inputValue();
  expect(editorValueBeforeSubmit).toBe(prompt);

  await promptInput.press("Enter");

  const userMessage = page.locator(".message.user").first();
  await expect(userMessage).toBeVisible({ timeout: 20000 });

  const receivedText = await userMessage.locator(".debug").textContent();

  for (const original of originals) {
    expect(receivedText).not.toContain(original);
  }

  for (const standin of standins) {
    expect(receivedText).toContain(standin);
  }

  expect(receivedText).toBe(`[Received: ${expected.safe_prompt}]`);

  const apiRequest = getLastApiRequest();
  expect(apiRequest).not.toBeNull();
  const userApiMessage = apiRequest.body.messages.find((message) => message.role === "user")?.content || "";
  expect(userApiMessage).toBe(prompt);
  expect(apiRequest.body.messages.some((message) => message.role === "system")).toBeTruthy();

  expect(logs.some((line) => line.includes("PrivacyAI intercepting prompt"))).toBeTruthy();

  return { receivedText, expected, logs };
}

test.describe("PrivacyAI complex prompt sanitization", () => {
  let chatUrl;
  let apiPort;

  test.beforeAll(async () => {
    const servers = await startTestServers();
    chatUrl = servers.chatUrl;
    apiPort = servers.apiPort;
  });

  test.afterAll(async () => {
    await stopTestServers();
  });

  for (const [index, prompt] of COMPLEX_SCENARIOS.entries()) {
    test(`sanitizes complex scenario ${index + 1} via local AI model`, async () => {
      const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: false,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`
        ]
      });

      try {
        await configureExtension(context, apiPort);
        const page = await context.newPage();
        await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
        await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });

        const { expected } = await runPromptTest(page, prompt);

        const hasNonEmailStandin = Object.keys(expected.session_map).some(
          (key) => !key.includes("@example.com")
        );
        expect(hasNonEmailStandin).toBeTruthy();
      } finally {
        await context.close();
      }
    });
  }

  test("sanitizes a varied generated prompt (not a fixed test string)", async () => {
    const varied = buildVariedPrompt(Date.now() % 997);
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    try {
      await configureExtension(context, apiPort);
      const page = await context.newPage();
      await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });

      const { receivedText } = await runPromptTest(page, varied.prompt);

      expect(receivedText).toContain("gsk_mock_ai_");
      expect(receivedText).toMatch(/Alex Morgan|Jordan Lee|Sam Rivera|Taylor Brooks/);
    } finally {
      await context.close();
    }
  });
});