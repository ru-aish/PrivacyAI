import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServers, stopTestServers, getLastApiRequest } from "./test-servers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "../dist");

async function waitForServiceWorker(context) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const workers = context.serviceWorkers();
    if (workers.length > 0) return workers[0];
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return context.waitForEvent("serviceworker", { timeout: 5000 });
}

test.describe("PrivacyAI on Gemini", () => {
  let apiPort;

  test.beforeAll(async () => {
    const servers = await startTestServers();
    apiPort = servers.apiPort;
  });

  test.afterAll(async () => {
    await stopTestServers();
  });

  test("injects bridge and intercepts Enter on gemini.google.com", async () => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    try {
      const serviceWorker = await waitForServiceWorker(context);
      await serviceWorker.evaluate((port) => chrome.storage.local.set({
        shieldEnabled: true,
        provider: "openai-compatible",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key"
      }), apiPort);

      const page = await context.newPage();
      const logs = [];
      page.on("console", (msg) => logs.push(msg.text()));

      await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(5000);

      await expect(page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout: 20000 });

      const bridgeInstalled = await page.evaluate(() => Boolean(window.__privacyAiBridgeInstalled));
      expect(bridgeInstalled).toBeTruthy();

      const prompt = "My email is gemini-test@example.com and I need help.";
      const editor = page.locator('div.ql-editor[contenteditable="true"].textarea').first();
      await editor.click();
      await page.keyboard.type(prompt);

      const editorBeforeEnter = await editor.innerText();
      expect(editorBeforeEnter).toContain("gemini-test@example.com");

      await editor.press("Enter");

      await page.waitForTimeout(8000);

      const intercepted = logs.some((line) => line.includes("PrivacyAI intercepting prompt"));
      const sanitized = logs.some((line) => line.includes("PrivacyAI sanitized"));
      const aiSource = logs.some((line) => line.includes("source: ai-sanitizer"));

      const apiRequest = getLastApiRequest();
      const userApiMessage = apiRequest?.body?.messages?.find((message) => message.role === "user")?.content || "";

      console.log("logs:", logs.filter((l) => l.includes("PrivacyAI")));
      console.log("api user message:", userApiMessage);

      expect(intercepted).toBeTruthy();
      expect(sanitized).toBeTruthy();
      expect(aiSource).toBeTruthy();
      expect(userApiMessage).toContain("gemini-test@example.com");
      expect(apiRequest.body.messages.some((message) => message.role === "system")).toBeTruthy();
    } finally {
      await context.close();
    }
  });
});