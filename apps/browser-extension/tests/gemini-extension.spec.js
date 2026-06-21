import { test, expect } from "@playwright/test";
import { startTestServers, stopTestServers, getLastApiRequest, resetApiRequests } from "./test-servers.mjs";
import { closeExtensionContext, configureExtensionViaStorage, launchExtensionContext, waitForServiceWorker } from "./extension-test-utils.mjs";

const COMPLEX_GEMINI_PROMPT = [
  "I'm Mira Patel from Cedar Ridge Bank and my email is mira.patel@cedarridge.example.",
  "Use this repo exactly: https://github.com/ru-aish/PrivacyAI and explain why the OAuth callback fails only after the browser extension rewrites the prompt.",
  "The private token in my failing .env is sk_live_gemini_complex_1234567890abcdef; keep the task technical and do not simplify the URL, model names, stack trace, or file paths.",
  "Stack trace: File \"/home/mira/projects/privacyai/apps/browser-extension/src/background.js\", line 48, in sanitizeText."
].join(" ");

const CONTEXT_TURNS = [
  {
    role: "user",
    text: "Earlier I said my staging email was mira.patel@cedarridge.example and the failing model was local-model."
  },
  {
    role: "assistant",
    text: "You were debugging the PrivacyAI extension config on Gemini with a custom OpenAI-compatible provider."
  }
];

function liveProviderConfig() {
  return {
    provider: process.env.PRIVACYAI_LIVE_PROVIDER || "custom",
    model: process.env.PRIVACYAI_LIVE_MODEL || "test-model",
    baseUrl: process.env.PRIVACYAI_LIVE_BASE_URL,
    apiKey: process.env.PRIVACYAI_LIVE_API_KEY
  };
}

function hasLiveProviderConfig() {
  const config = liveProviderConfig();
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

function mockProviderConfig(apiPort) {
  return {
    provider: "custom",
    model: "test-model",
    baseUrl: `http://127.0.0.1:${apiPort}/v1`,
    apiKey: "test-key"
  };
}

async function injectSyntheticGeminiHistory(page) {
  await page.evaluate((turns) => {
    const host = document.createElement("section");
    host.id = "privacyai-test-context-history";
    host.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden";

    for (const turn of turns) {
      const message = document.createElement("div");
      message.setAttribute("data-message-author-role", turn.role === "assistant" ? "model" : "user");
      message.innerText = turn.text;
      host.appendChild(message);
    }

    document.body.prepend(host);
  }, CONTEXT_TURNS);
}

function textFromPrivacyLogs(logs) {
  return logs.filter((line) => line.includes("PrivacyAI")).join("\n");
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

  test.beforeEach(() => {
    resetApiRequests();
  });

  test("injects bridge and sanitizes a complex Gemini prompt with context", async () => {
    const context = await launchExtensionContext();
    const logs = [];
    const workerLogs = [];

    try {
      const serviceWorker = await waitForServiceWorker(context);
      serviceWorker.on("console", (msg) => workerLogs.push(msg.text()));

      const providerConfig = hasLiveProviderConfig()
        ? liveProviderConfig()
        : mockProviderConfig(apiPort);

      await configureExtensionViaStorage(context, {
        shieldEnabled: true,
        ...providerConfig
      });

      const page = await context.newPage();
      page.on("console", (msg) => logs.push(msg.text()));

      await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(5000);

      await expect(page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout: 20000 });

      const bridgeInstalled = await page.evaluate(() => Boolean(window.__privacyAiBridgeInstalled));
      expect(bridgeInstalled).toBeTruthy();

      await injectSyntheticGeminiHistory(page);

      const editor = page.locator('div.ql-editor[contenteditable="true"].textarea').first();
      await editor.click();
      await page.keyboard.type(COMPLEX_GEMINI_PROMPT);

      const editorBeforeEnter = await editor.innerText();
      expect(editorBeforeEnter).toContain("mira.patel@cedarridge.example");
      expect(editorBeforeEnter).toContain("sk_live_gemini_complex_1234567890abcdef");

      await editor.press("Enter");

      await expect.poll(() => textFromPrivacyLogs(logs), { timeout: 90000 }).toContain("PrivacyAI sanitized");

      const privacyLogs = textFromPrivacyLogs(logs);
      expect(privacyLogs).toContain("PrivacyAI intercepting prompt");
      expect(privacyLogs).toMatch(/source: (ai-sanitizer|regex-fallback)/);
      const sanitizedLog = logs.find((line) => line.includes("PrivacyAI sanitized via background")) || "";
      expect(sanitizedLog).not.toContain("sk_live_gemini_complex_1234567890abcdef");
      expect(sanitizedLog).not.toContain("mira.patel@cedarridge.example");

      if (hasLiveProviderConfig()) {
        expect(workerLogs.join("\n")).toContain("PrivacyAI: sanitizing via API");
        expect(workerLogs.join("\n")).toContain(providerConfig.model);
      } else {
        const apiRequest = getLastApiRequest();
        expect(apiRequest).not.toBeNull();
        expect(apiRequest.body.model).toBe("test-model");
        expect(apiRequest.body.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "user",
              content: `[CONTEXT] ${CONTEXT_TURNS[0].text}`
            }),
            expect.objectContaining({
              role: "assistant",
              content: `[CONTEXT] ${CONTEXT_TURNS[1].text}`
            })
          ])
        );
        expect(apiRequest.body.messages.at(-1)).toMatchObject({
          role: "user",
          content: COMPLEX_GEMINI_PROMPT
        });
      }
    } finally {
      await closeExtensionContext(context);
    }
  });

  test("sanitizes context text before sending to remote provider", async () => {
    const context = await launchExtensionContext();
    const workerLogs = [];

    try {
      const serviceWorker = await waitForServiceWorker(context);
      serviceWorker.on("console", (msg) => workerLogs.push(msg.text()));

      await configureExtensionViaStorage(context, {
        shieldEnabled: true,
        provider: "openai-compatible",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        apiKey: "remote-api-key"
      });

      // Instead of relying on Gemini DOM which might not have context history locally
      // Let's trigger the background sanitize action directly from a page context
            const extensionId = serviceWorker.url().split("/")[2];
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);

      const response = await page.evaluate(() => {
        return new Promise(resolve => {
          chrome.runtime.sendMessage({
            action: "sanitize",
            text: "Here is my prompt",
            context: [
              { role: "user", text: "My email is sensitive@example.com." },
              { role: "assistant", text: "Got it." }
            ]
          }, resolve);
        });
      });

      expect(response.success).toBe(true);

      const apiRequest = getLastApiRequest();
      expect(apiRequest).not.toBeNull();

      const sentContext = apiRequest.body.messages.filter(m => m.content && m.content.includes("[CONTEXT]"));
      expect(sentContext.length).toBeGreaterThan(0);
      expect(sentContext[0].content).not.toContain("sensitive@example.com");
      expect(typeof sentContext[0].content).toBe("string");
      expect(sentContext[0].content.length).toBeGreaterThan(0);

    } finally {
      await closeExtensionContext(context);
    }
  });
});
