# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: extension.spec.js >> PrivacyAI browser extension >> intercepts Enter, calls AI sanitizer, and submits redacted prompt
- Location: tests/extension.spec.js:52:3

# Error details

```
Error: expect(received).toBeTruthy()

Received: false
```

# Test source

```ts
  1   | import { test, expect, chromium } from "@playwright/test";
  2   | import path from "node:path";
  3   | import { fileURLToPath } from "node:url";
  4   | import { startTestServers, stopTestServers, getLastApiRequest } from "./test-servers.mjs";
  5   |
  6   | const __dirname = path.dirname(fileURLToPath(import.meta.url));
  7   | const extensionPath = path.resolve(__dirname, "../dist");
  8   |
  9   | async function waitForServiceWorker(context) {
  10  |   for (let attempt = 0; attempt < 30; attempt += 1) {
  11  |     const workers = context.serviceWorkers();
  12  |     if (workers.length > 0) {
  13  |       return workers[0];
  14  |     }
  15  |     await new Promise((resolve) => setTimeout(resolve, 500));
  16  |   }
  17  |   return context.waitForEvent("serviceworker", { timeout: 5000 });
  18  | }
  19  |
  20  | async function configureExtension(context, apiPort) {
  21  |   const page = await context.newPage();
  22  |   await page.goto("about:blank");
  23  |
  24  |   const serviceWorker = await waitForServiceWorker(context);
  25  |   await serviceWorker.evaluate((port) => {
  26  |     return chrome.storage.local.set({
  27  |       shieldEnabled: true,
  28  |       provider: "openai-compatible",
  29  |       model: "test-model",
  30  |       baseUrl: `http://127.0.0.1:${port}/v1`,
  31  |       apiKey: "test-key"
  32  |     });
  33  |   }, apiPort);
  34  |
  35  |   await page.close();
  36  | }
  37  |
  38  | test.describe("PrivacyAI browser extension", () => {
  39  |   let chatUrl;
  40  |   let apiPort;
  41  |
  42  |   test.beforeAll(async () => {
  43  |     const servers = await startTestServers();
  44  |     chatUrl = servers.chatUrl;
  45  |     apiPort = servers.apiPort;
  46  |   });
  47  |
  48  |   test.afterAll(async () => {
  49  |     await stopTestServers();
  50  |   });
  51  |
  52  |   test("intercepts Enter, calls AI sanitizer, and submits redacted prompt", async () => {
  53  |     const context = await chromium.launchPersistentContext("", {
  54  |       channel: "chromium",
  55  |       headless: false,
  56  |       args: [
  57  |         `--disable-extensions-except=${extensionPath}`,
  58  |         `--load-extension=${extensionPath}`
  59  |       ]
  60  |     });
  61  |
  62  |     try {
  63  |       await configureExtension(context, apiPort);
  64  |
  65  |       const page = await context.newPage();
  66  |       const logs = [];
  67  |       page.on("console", (msg) => logs.push(msg.text()));
  68  |
  69  |       await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
  70  |
  71  |       await expect(page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout: 15000 });
  72  |       await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });
  73  |
  74  |       const promptInput = page.locator("#prompt-input");
  75  |       const prompt = "My email is testuser123@example.com and I need help.";
  76  |
  77  |       await promptInput.fill(prompt);
  78  |       await promptInput.press("Enter");
  79  |
  80  |       const userMessage = page.locator(".message.user").first();
  81  |       await expect(userMessage).toBeVisible({ timeout: 20000 });
  82  |
  83  |       const receivedText = await userMessage.locator(".debug").textContent();
  84  |       expect(receivedText).toContain("contact1@example.com");
  85  |       expect(receivedText).not.toContain("testuser123@example.com");
  86  |
  87  |       const apiRequest = getLastApiRequest();
  88  |       expect(apiRequest).not.toBeNull();
  89  |       expect(apiRequest.url).toContain("/chat/completions");
  90  |       expect(apiRequest.body.messages.some((message) => message.role === "system")).toBeTruthy();
  91  |
  92  |       expect(logs.some((line) => line.includes("PrivacyAI intercepting prompt"))).toBeTruthy();
  93  |       expect(logs.some((line) => line.includes("PrivacyAI sanitized via background"))).toBeTruthy();
> 94  |       expect(logs.some((line) => line.includes("source: ai-sanitizer"))).toBeTruthy();
      |                                                                          ^ Error: expect(received).toBeTruthy()
  95  |
  96  |       const userApiMessage = apiRequest.body.messages.find((message) => message.role === "user")?.content || "";
  97  |       expect(userApiMessage).toBe(prompt);
  98  |     } finally {
  99  |       await context.close();
  100 |     }
  101 |   });
  102 | });
```