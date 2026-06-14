import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServers, stopTestServers } from "./test-servers.mjs";

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

test.describe("PrivacyAI on ProseMirror mock", () => {
  let chatUrl;
  let apiPort;

  test.beforeAll(async () => {
    const servers = await startTestServers();
    chatUrl = servers.chatUrl.replace('mock-chat.html', 'prosemirror-mock.html');
    apiPort = servers.apiPort;
  });

  test.afterAll(async () => {
    await stopTestServers();
  });

  test("submits sanitized prompt through ProseMirror editor", async () => {
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
      await page.goto(chatUrl, { waitUntil: "domcontentloaded" });

      await expect(page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout: 15000 });

      const editor = page.locator('#prompt-textarea');
      await editor.click();
      await page.keyboard.type("My email is prose@example.com and I need help.");
      await editor.press("Enter");

      const userMessage = page.locator('.message.user').first();
      await expect(userMessage).toBeVisible({ timeout: 20000 });

      const sent = await userMessage.getAttribute('data-sent');
      expect(sent).toContain('contact1@example.com');
      expect(sent).not.toContain('prose@example.com');
    } finally {
      await context.close();
    }
  });
});