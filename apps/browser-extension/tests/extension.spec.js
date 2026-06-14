import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServers, stopTestServers, getLastApiRequest } from "./test-servers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "../dist");

async function waitForServiceWorker(context) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const workers = context.serviceWorkers();
    if (workers.length > 0) {
      return workers[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return context.waitForEvent("serviceworker", { timeout: 5000 });
}

async function configureExtension(context, apiPort) {
  const page = await context.newPage();
  await page.goto("about:blank");

  const serviceWorker = await waitForServiceWorker(context);
  await serviceWorker.evaluate((port) => {
    return chrome.storage.local.set({
      shieldEnabled: true,
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key"
    });
  }, apiPort);

  await page.close();
}

test.describe("PrivacyAI browser extension", () => {
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

  test("intercepts Enter, calls AI sanitizer, and submits redacted prompt", async () => {
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
      const logs = [];
      page.on("console", (msg) => logs.push(msg.text()));

      await page.goto(chatUrl, { waitUntil: "domcontentloaded" });

      await expect(page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout: 15000 });
      await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });

      const promptInput = page.locator("#prompt-input");
      const prompt = "My email is testuser123@example.com and I need help.";

      await promptInput.fill(prompt);
      await promptInput.press("Enter");

      const userMessage = page.locator(".message.user").first();
      await expect(userMessage).toBeVisible({ timeout: 20000 });

      const receivedText = await userMessage.locator(".debug").textContent();
      expect(receivedText).toContain("contact1@example.com");
      expect(receivedText).not.toContain("testuser123@example.com");

      const apiRequest = getLastApiRequest();
      expect(apiRequest).not.toBeNull();
      expect(apiRequest.url).toContain("/chat/completions");
      expect(apiRequest.body.messages.some((message) => message.role === "system")).toBeTruthy();

      expect(logs.some((line) => line.includes("PrivacyAI intercepting prompt"))).toBeTruthy();
      expect(logs.some((line) => line.includes("PrivacyAI sanitized via background"))).toBeTruthy();

      const userApiMessage = apiRequest.body.messages.find((message) => message.role === "user")?.content || "";
      expect(userApiMessage).toBe(prompt);
    } finally {
      await context.close();
    }
  });
});