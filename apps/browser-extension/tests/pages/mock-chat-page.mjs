import { expect } from "@playwright/test";

export class MockChatPage {
  constructor(page) {
    this.page = page;
    this.promptInput = page.locator("#prompt-input");
    this.chatHistory = page.locator("#chat-history");
    this.badge = page.locator("#privacyai-badge");
  }

  async goto(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async waitForShieldActive(timeout = 15000) {
    await expect(this.page.locator("html")).toHaveAttribute("data-privacyai", "active", { timeout });
  }

  async waitForBadgeText(text, timeout = 15000) {
    await expect(this.badge).toHaveText(text, { timeout });
  }

  async typePrompt(text) {
    await this.promptInput.fill(text);
  }

  async sendPrompt() {
    await this.promptInput.press("Enter");
  }

  async getLastUserMessage() {
    const userMessages = this.page.locator(".message.user");
    return userMessages.last();
  }

  async addConversationTurn(role, text) {
    await this.page.evaluate(({ role, text }) => {
      const el = document.createElement("div");
      el.className = `message ${role === "user" ? "user" : "ai"}`;
      el.innerText = text;
      document.getElementById("chat-history").appendChild(el);
    }, { role, text });
  }

  async getLastUserMessageText() {
    const msg = await this.getLastUserMessage();
    return msg.locator(".debug").textContent();
  }
}
