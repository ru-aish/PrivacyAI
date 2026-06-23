import { test, expect } from "@playwright/test";
import { startTestServers, stopTestServers, getLastApiRequest, resetApiRequests } from "./test-servers.mjs";
import {
  closeExtensionContext,
  configureExtensionViaPopup,
  configureExtensionViaStorage,
  launchExtensionContext
} from "./extension-test-utils.mjs";

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

  test.beforeEach(() => {
    resetApiRequests();
  });

  test("intercepts Enter, calls AI sanitizer, and submits redacted prompt", async () => {
    const context = await launchExtensionContext();

    try {
      await configureExtensionViaStorage(context, {
        provider: "custom",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        apiKey: "test-key"
      });

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
      expect(apiRequest.body.model).toBe("test-model");
      expect(apiRequest.body.messages.some((message) => message.role === "system")).toBeTruthy();

      expect(logs.some((line) => line.includes("PrivacyAI intercepting prompt"))).toBeTruthy();
      expect(logs.some((line) => line.includes("PrivacyAI sanitized via background"))).toBeTruthy();
      expect(logs.some((line) => line.includes("source: ai-sanitizer"))).toBeTruthy();

      const userApiMessage = apiRequest.body.messages.at(-1)?.content || "";
      expect(userApiMessage).toBe(prompt);
    } finally {
      await closeExtensionContext(context);
    }
  });

  test("saves custom provider settings through popup and forwards conversation context", async () => {
    const context = await launchExtensionContext();

    try {
      const stored = await configureExtensionViaPopup(context, {
        provider: "custom",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        apiKey: "test-key"
      });

      expect(stored).toMatchObject({
        shieldEnabled: true,
        provider: "custom",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        apiKey: "test-key"
      });

      const page = await context.newPage();
      await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#privacyai-badge")).toHaveText("PrivacyAI connected", { timeout: 15000 });

      await page.evaluate(() => {
        const chatHistory = document.getElementById("chat-history");
        const firstUser = document.createElement("div");
        firstUser.className = "message user";
        firstUser.innerText = "Earlier I said my email was alice.original@example.com.";

        const firstAssistant = document.createElement("div");
        firstAssistant.className = "message ai";
        firstAssistant.innerText = "I can help Alice draft a reply.";

        chatHistory.append(firstUser, firstAssistant);
      });

      const prompt = "Now write a concise reply for Alice.";
      const promptInput = page.locator("#prompt-input");
      await promptInput.fill(prompt);
      await promptInput.press("Enter");

      const userMessages = page.locator(".message.user");
      await expect(userMessages).toHaveCount(2, { timeout: 20000 });

      const apiRequest = getLastApiRequest();
      expect(apiRequest).not.toBeNull();
      expect(apiRequest.body.model).toBe("test-model");

      const messages = apiRequest.body.messages;
      expect(messages[0].role).toBe("system");
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Mock compacted context summary")
          })
        ])
      );
      expect(messages.at(-1)).toMatchObject({ role: "user", content: prompt });
    } finally {
      await closeExtensionContext(context);
    }
  });
});
