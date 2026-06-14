# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: gemini-extension.spec.js >> PrivacyAI on Gemini >> injects bridge and intercepts Enter on gemini.google.com
- Location: tests/gemini-extension.spec.js:30:3

# Error details

```
Error: expect(received).toBeTruthy()

Received: false
```

# Test source

```ts
  1  | import { test, expect, chromium } from "@playwright/test";
  2  | import path from "node:path";
  3  | import { fileURLToPath } from "node:url";
  4  | import { startTestServers, stopTestServers, getLastApiRequest } from "./test-servers.mjs";
  5  |
  6  | const __dirname = path.dirname(fileURLToPath(import.meta.url));
  7  | const extensionPath = path.resolve(__dirname, "../dist");
  8  |
  9  | async function waitForServiceWorker(context) {
  10 |   for (let attempt = 0; attempt < 30; attempt += 1) {
  11 |     const workers = context.serviceWorkers();
  12 |     if (workers.length > 0) return workers[0];
  13 |     await new Promise((resolve) => setTimeout(resolve, 500));
  14 |   }
  15 |   return context.waitForEvent("serviceworker", { timeout: 5000 });
  16 | }
  17 |
  18 | test.describe("PrivacyAI on Gemini", () => {
  19 |   let apiPort;
  20 |
  21 |   test.beforeAll(async () => {
  22 |     const servers = await startTestServers();
  23 |     apiPort = servers.apiPort;
  24 |   });
  25 |
  26 |   test.afterAll(async () => {
  27 |     await stopTestServers();
  28 |   });
  29 |
  30 |   test("injects bridge and intercepts Enter on gemini.google.com", async () => {
  31 |     const context = await chromium.launchPersistentContext("", {
  32 |       channel: "chromium",
  33 |       headless: false,
  34 |       args: [
  35 |         `--disable-extensions-except=${extensionPath}`,
  36 |         `--load-extension=${extensionPath}`
  37 |       ]
  38 |     });
  39 |
  40 |     try {
  41 |       const serviceWorker = await waitForServiceWorker(context);
  42 |       await serviceWorker.evaluate((port) => chrome.storage.local.set({
  43 |         shieldEnabled: true,
  44 |         provider: "openai-compatible",
  45 |         model: "test-model",
  46 |         baseUrl: `http://127.0.0.1:${port}/v1`,
  47 |         apiKey: "test-key"
  48 |       }), apiPort);
  49 |
  50 |       const page = await context.newPage();
  51 |       const logs = [];
  52 |       page.on("console", (msg) => logs.push(msg.text()));
  53 |
  54 |       await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 45000 });
  55 |       await page.waitForTimeout(5000);
  56 |
  57 |       await expect(page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout: 20000 });
  58 |
  59 |       const bridgeInstalled = await page.evaluate(() => Boolean(window.__privacyAiBridgeInstalled));
  60 |       expect(bridgeInstalled).toBeTruthy();
  61 |
  62 |       const prompt = "My email is gemini-test@example.com and I need help.";
  63 |       const editor = page.locator('div.ql-editor[contenteditable="true"].textarea').first();
  64 |       await editor.click();
  65 |       await page.keyboard.type(prompt);
  66 |
  67 |       const editorBeforeEnter = await editor.innerText();
  68 |       expect(editorBeforeEnter).toContain("gemini-test@example.com");
  69 |
  70 |       await editor.press("Enter");
  71 |
  72 |       await page.waitForTimeout(8000);
  73 |
  74 |       const intercepted = logs.some((line) => line.includes("PrivacyAI intercepting prompt"));
  75 |       const sanitized = logs.some((line) => line.includes("PrivacyAI sanitized"));
  76 |       const aiSource = logs.some((line) => line.includes("source: ai-sanitizer"));
  77 |
  78 |       const apiRequest = getLastApiRequest();
  79 |       const userApiMessage = apiRequest?.body?.messages?.find((message) => message.role === "user")?.content || "";
  80 |
  81 |       console.log("logs:", logs.filter((l) => l.includes("PrivacyAI")));
  82 |       console.log("api user message:", userApiMessage);
  83 |
  84 |       expect(intercepted).toBeTruthy();
  85 |       expect(sanitized).toBeTruthy();
> 86 |       expect(aiSource).toBeTruthy();
     |                        ^ Error: expect(received).toBeTruthy()
  87 |       expect(userApiMessage).toContain("gemini-test@example.com");
  88 |       expect(apiRequest.body.messages.some((message) => message.role === "system")).toBeTruthy();
  89 |     } finally {
  90 |       await context.close();
  91 |     }
  92 |   });
  93 | });
```