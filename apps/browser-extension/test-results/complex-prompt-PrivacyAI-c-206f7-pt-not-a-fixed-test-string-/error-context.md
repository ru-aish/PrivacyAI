# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: complex-prompt.spec.js >> PrivacyAI complex prompt sanitization >> sanitizes a varied generated prompt (not a fixed test string)
- Location: tests/complex-prompt.spec.js:137:3

# Error details

```
Error: expect(received).not.toContain(expected) // indexOf

Expected substring: not "gsk_deploy_key_9x1"
Received string:        "[Received: Please help me debug billing. I'm Alex Morgan, phone +1 (555) 010-0001, credential gsk_deploy_key_9x1.]"
```

# Test source

```ts
  1   | import { test, expect, chromium } from "@playwright/test";
  2   | import path from "node:path";
  3   | import { fileURLToPath } from "node:url";
  4   | import { startTestServers, stopTestServers, getLastApiRequest } from "./test-servers.mjs";
  5   | import { mockAiSanitize } from "./mock-ai-sanitizer.mjs";
  6   |
  7   | const __dirname = path.dirname(fileURLToPath(import.meta.url));
  8   | const extensionPath = path.resolve(__dirname, "../dist");
  9   |
  10  | const COMPLEX_SCENARIOS = [
  11  |   "I'm Eleanor Vance, call me at 415-555-9821. Groq API key: gsk_live_secret_xyz99",
  12  |   "I work at Harborview Systems. SSN 482-91-3307. Email priya.k@corp.net for follow-up.",
  13  |   "I'm Marcus Chen. I work at Summit Analytics LLC. Phone (212) 555-4419. Key sk_test_billing_88aa01"
  14  | ];
  15  |
  16  | function buildVariedPrompt(seed) {
  17  |   const names = ["Sofia Alvarez", "Priya Kapoor", "Derek Whitman", "Amara Okafor"];
  18  |   const phones = ["628-444-1098", "773-555-8820", "305-555-7124"];
  19  |   const keys = ["gsk_prod_7f2a9c1b", "gsk_user_auth_44ef12", "gsk_deploy_key_9x1"];
  20  |   const pick = (arr) => arr[seed % arr.length];
  21  |
  22  |   const name = pick(names);
  23  |   const phone = pick(phones);
  24  |   const key = pick(keys);
  25  |   const prompt = `Please help me debug billing. I'm ${name}, phone ${phone}, credential ${key}.`;
  26  |
  27  |   return { prompt, expected: mockAiSanitize(prompt), originals: [name, phone, key] };
  28  | }
  29  |
  30  | async function waitForServiceWorker(context) {
  31  |   for (let attempt = 0; attempt < 30; attempt += 1) {
  32  |     const workers = context.serviceWorkers();
  33  |     if (workers.length > 0) return workers[0];
  34  |     await new Promise((resolve) => setTimeout(resolve, 500));
  35  |   }
  36  |   return context.waitForEvent("serviceworker", { timeout: 5000 });
  37  | }
  38  |
  39  | async function configureExtension(context, apiPort) {
  40  |   const page = await context.newPage();
  41  |   await page.goto("about:blank");
  42  |   const serviceWorker = await waitForServiceWorker(context);
  43  |   await serviceWorker.evaluate((port) => chrome.storage.local.set({
  44  |     shieldEnabled: true,
  45  |     provider: "openai-compatible",
  46  |     model: "test-model",
  47  |     baseUrl: `http://127.0.0.1:${port}/v1`,
  48  |     apiKey: "test-key"
  49  |   }), apiPort);
  50  |   await page.close();
  51  | }
  52  |
  53  | async function runPromptTest(page, prompt) {
  54  |   const expected = mockAiSanitize(prompt);
  55  |   const originals = Object.values(expected.session_map);
  56  |   const standins = Object.keys(expected.session_map);
  57  |   const logs = [];
  58  |   page.on("console", (msg) => logs.push(msg.text()));
  59  |
  60  |   const promptInput = page.locator("#prompt-input");
  61  |   await promptInput.fill(prompt);
  62  |
  63  |   const editorValueBeforeSubmit = await promptInput.inputValue();
  64  |   expect(editorValueBeforeSubmit).toBe(prompt);
  65  |
  66  |   await promptInput.press("Enter");
  67  |
  68  |   const userMessage = page.locator(".message.user").first();
  69  |   await expect(userMessage).toBeVisible({ timeout: 20000 });
  70  |
  71  |   const receivedText = await userMessage.locator(".debug").textContent();
  72  |
  73  |   for (const original of originals) {
> 74  |     expect(receivedText).not.toContain(original);
      |                              ^ Error: expect(received).not.toContain(expected) // indexOf
  75  |   }
  76  |
  77  |   for (const standin of standins) {
  78  |     expect(receivedText).toContain(standin);
  79  |   }
  80  |
  81  |   expect(receivedText).toBe(`[Received: ${expected.safe_prompt}]`);
  82  |
  83  |   const apiRequest = getLastApiRequest();
  84  |   expect(apiRequest).not.toBeNull();
  85  |   const userApiMessage = apiRequest.body.messages.find((message) => message.role === "user")?.content || "";
  86  |   expect(userApiMessage).toBe(prompt);
  87  |   expect(apiRequest.body.messages.some((message) => message.role === "system")).toBeTruthy();
  88  |
  89  |   expect(logs.some((line) => line.includes("PrivacyAI intercepting prompt"))).toBeTruthy();
  90  |
  91  |   return { receivedText, expected, logs };
  92  | }
  93  |
  94  | test.describe("PrivacyAI complex prompt sanitization", () => {
  95  |   let chatUrl;
  96  |   let apiPort;
  97  |
  98  |   test.beforeAll(async () => {
  99  |     const servers = await startTestServers();
  100 |     chatUrl = servers.chatUrl;
  101 |     apiPort = servers.apiPort;
  102 |   });
  103 |
  104 |   test.afterAll(async () => {
  105 |     await stopTestServers();
  106 |   });
  107 |
  108 |   for (const [index, prompt] of COMPLEX_SCENARIOS.entries()) {
  109 |     test(`sanitizes complex scenario ${index + 1} via local AI model`, async () => {
  110 |       const context = await chromium.launchPersistentContext("", {
  111 |         channel: "chromium",
  112 |         headless: false,
  113 |         args: [
  114 |           `--disable-extensions-except=${extensionPath}`,
  115 |           `--load-extension=${extensionPath}`
  116 |         ]
  117 |       });
  118 |
  119 |       try {
  120 |         await configureExtension(context, apiPort);
  121 |         const page = await context.newPage();
  122 |         await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
  123 |         await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });
  124 |
  125 |         const { expected } = await runPromptTest(page, prompt);
  126 |
  127 |         const hasNonEmailStandin = Object.keys(expected.session_map).some(
  128 |           (key) => !key.includes("@example.com")
  129 |         );
  130 |         expect(hasNonEmailStandin).toBeTruthy();
  131 |       } finally {
  132 |         await context.close();
  133 |       }
  134 |     });
  135 |   }
  136 |
  137 |   test("sanitizes a varied generated prompt (not a fixed test string)", async () => {
  138 |     const varied = buildVariedPrompt(Date.now() % 997);
  139 |     const context = await chromium.launchPersistentContext("", {
  140 |       channel: "chromium",
  141 |       headless: false,
  142 |       args: [
  143 |         `--disable-extensions-except=${extensionPath}`,
  144 |         `--load-extension=${extensionPath}`
  145 |       ]
  146 |     });
  147 |
  148 |     try {
  149 |       await configureExtension(context, apiPort);
  150 |       const page = await context.newPage();
  151 |       await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
  152 |       await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });
  153 |
  154 |       const { receivedText } = await runPromptTest(page, varied.prompt);
  155 |
  156 |       expect(receivedText).toContain("gsk_mock_ai_");
  157 |       expect(receivedText).toMatch(/Alex Morgan|Jordan Lee|Sam Rivera|Taylor Brooks/);
  158 |     } finally {
  159 |       await context.close();
  160 |     }
  161 |   });
  162 | });
```