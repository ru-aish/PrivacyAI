import { expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const extensionPath = path.resolve(__dirname, "../dist");

export async function waitForServiceWorker(context) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const workers = context.serviceWorkers();
    if (workers.length > 0) {
      return workers[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return context.waitForEvent("serviceworker", { timeout: 5000 });
}

export async function launchExtensionContext(options = {}) {
  return chromium.launchPersistentContext(options.userDataDir || "", {
    channel: options.channel || process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chromium",
    headless: false,
    args: [
      "--no-sandbox",
      "--ozone-platform=x11",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...(options.args || [])
    ]
  });
}

export async function configureExtensionViaStorage(context, config = {}) {
  const serviceWorker = await waitForServiceWorker(context);
  const storedConfig = {
    shieldEnabled: true,
    provider: "custom",
    model: "test-model",
    baseUrl: config.baseUrl,
    apiKey: "test-key",
    ...config
  };

  await serviceWorker.evaluate((value) => chrome.storage.local.set(value), storedConfig);
  return storedConfig;
}

export function getExtensionId(serviceWorker) {
  return new URL(serviceWorker.url()).hostname;
}

export async function configureExtensionViaPopup(context, config = {}) {
  const serviceWorker = await waitForServiceWorker(context);
  const extensionId = getExtensionId(serviceWorker);
  const popup = await context.newPage();
  const storedConfig = {
    shieldEnabled: true,
    provider: "custom",
    model: "test-model",
    baseUrl: config.baseUrl,
    apiKey: "test-key",
    ...config
  };

  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator("#toggleShield").setChecked(Boolean(storedConfig.shieldEnabled));

  const providerField = popup.locator("#provider");
  const advancedToggle = popup.locator("#advancedToggle");
  if ((await advancedToggle.count()) > 0 && !(await providerField.isVisible())) {
    await advancedToggle.click();
  }

  await expect(providerField).toBeVisible({ timeout: 5000 });
  await providerField.fill(storedConfig.provider);
  await popup.locator("#model").fill(storedConfig.model);
  await popup.locator("#baseUrl").fill(storedConfig.baseUrl);
  await popup.locator("#apiKey").fill(storedConfig.apiKey);
  await popup.locator("#saveBtn").click();
  await expect(popup.locator("#status")).toContainText("Saved!", { timeout: 5000 });

  const stored = await serviceWorker.evaluate(() =>
    chrome.storage.local.get(["shieldEnabled", "provider", "model", "baseUrl", "apiKey"])
  );
  await popup.close();
  return stored;
}

export async function closeExtensionContext(context) {
  const keepOpenMs = Number(process.env.PRIVACYAI_E2E_KEEP_BROWSER_OPEN_MS || 0);
  if (keepOpenMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, keepOpenMs));
  }
  await context.close();
}
