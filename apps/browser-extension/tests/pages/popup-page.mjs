import { expect } from "@playwright/test";

export class PopupPage {
  constructor(page) {
    this.page = page;
  }

  async openAdvancedConfigIfNeeded() {
    const providerField = this.page.locator("#provider");
    const advancedToggle = this.page.locator("#advancedToggle");
    if ((await advancedToggle.count()) > 0 && !(await providerField.isVisible())) {
      await advancedToggle.click();
    }
    await expect(providerField).toBeVisible({ timeout: 5000 });
  }

  async saveProviderConfig(config) {
    await this.openAdvancedConfigIfNeeded();
    await this.page.locator("#provider").fill(config.provider);
    await this.page.locator("#model").fill(config.model);
    await this.page.locator("#baseUrl").fill(config.baseUrl);
    await this.page.locator("#apiKey").fill(config.apiKey);
    await this.page.locator("#saveBtn").click();
    await expect(this.page.locator("#status")).toContainText("Saved!", { timeout: 5000 });
  }
}
