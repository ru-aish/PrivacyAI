import { test, expect } from "@playwright/test";
import { startTestServers, stopTestServers, resetApiRequests } from "./test-servers.mjs";
import {
  closeExtensionContext,
  configureExtensionViaStorage,
  launchExtensionContext
} from "./extension-test-utils.mjs";

test.describe("PrivacyAI browser extension UI and History Improvements", () => {
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

  test.beforeEach(() => {
    resetApiRequests();
  });

  test("background records protections accurately and masks PII properly", async () => {
    const context = await launchExtensionContext();

    try {
      let [background] = context.serviceWorkers();
      if (!background) background = await context.waitForEvent("serviceworker");

      await configureExtensionViaStorage(context, {
        provider: "custom",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        apiKey: "test-key"
      });

      const page = await context.newPage();
      await page.goto(chatUrl, { waitUntil: "domcontentloaded" });

      await expect(page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout: 15000 });
      await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });

      const promptInput = page.locator("#prompt-input");
      const prompt = "My email is secure.user@example.com and my phone is 555-0199.";
      await promptInput.fill(prompt);
      await promptInput.press("Enter");

      const userMessage = page.locator(".message.user").first();
      await expect(userMessage).toBeVisible({ timeout: 20000 });

      await page.waitForTimeout(1000);

      // Verify history by going to the popup HTML that communicates with background
      const popup = await context.newPage();
      await popup.goto("chrome-extension://" + background.url().split('/')[2] + "/popup.html");
      await popup.waitForLoadState('domcontentloaded');

      const historyResult = await popup.evaluate(() => {
        return new Promise(resolve => {
          chrome.runtime.sendMessage({ action: "getProtectionHistory" }, resolve);
        });
      });

      expect(historyResult.success).toBe(true);
      expect(historyResult.history.length).toBeGreaterThan(0);

      const latest = historyResult.history[0];

      expect(latest.cappedPreview).not.toContain("secure.user@example.com");
      expect(latest.cappedPreview).not.toContain("555-0199");
      expect(latest.originalText).toBeUndefined();

      expect(latest.counts).toBeDefined();

      const masks = Object.values(latest.maskedSessionMap);
      expect(masks.some(v => v.includes("***@example.com"))).toBe(true);

    } finally {
      await closeExtensionContext(context);
    }
  });

  test("clear history functionality works correctly", async () => {
    const context = await launchExtensionContext();

    try {
      let [background] = context.serviceWorkers();
      if (!background) background = await context.waitForEvent("serviceworker");

      await configureExtensionViaStorage(context, {
        provider: "custom",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        apiKey: "test-key"
      });

      const page = await context.newPage();
      await page.goto(chatUrl, { waitUntil: "domcontentloaded" });

      const promptInput = page.locator("#prompt-input");
      await promptInput.fill("My secret is here.");
      await promptInput.press("Enter");
      await page.locator(".message.user").first().waitFor({ state: "visible", timeout: 20000 });

      await page.waitForTimeout(500);

      const popup = await context.newPage();
      await popup.goto("chrome-extension://" + background.url().split('/')[2] + "/popup.html");
      await popup.waitForLoadState('domcontentloaded');

      const clearResult = await popup.evaluate(() => {
        return new Promise(resolve => {
          chrome.runtime.sendMessage({ action: "clearProtectionHistory" }, resolve);
        });
      });
      expect(clearResult.success).toBe(true);

      const historyResult = await popup.evaluate(() => {
        return new Promise(resolve => {
          chrome.runtime.sendMessage({ action: "getProtectionHistory" }, resolve);
        });
      });
      expect(historyResult.history.length).toBe(0);

    } finally {
      await closeExtensionContext(context);
    }
  });

  test("provider health check mock integration", async () => {
    const context = await launchExtensionContext();

    try {
      let [background] = context.serviceWorkers();
      if (!background) background = await context.waitForEvent("serviceworker");

      const config = {
        provider: "openai-compatible",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        apiKey: "test-key"
      };

      const popup = await context.newPage();
      await popup.goto("chrome-extension://" + background.url().split('/')[2] + "/popup.html");
      await popup.waitForLoadState('domcontentloaded');

      const testResult = await popup.evaluate((cfg) => {
        return new Promise(resolve => {
          chrome.runtime.sendMessage({ action: "testProvider", config: cfg }, resolve);
        });
      }, config);

      expect(testResult.success).toBe(false);
      expect(testResult.healthy).toBe(false);
      expect(testResult.message).toBe("Connection failed");

    } finally {
      await closeExtensionContext(context);
    }
  });
});
