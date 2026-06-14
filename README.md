# 🛡️ PrivacyAI

PrivacyAI is a local-first privacy and sanitization layer that intercepts and redacts Personally Identifiable Information (PII), credentials, and sensitive data before they are sent to AI chat models (like ChatGPT, Claude, and Gemini).

It consists of a developer SDK (`@privacy-ai/sdk`), a browser extension to protect your daily chat workflows, and a local web demonstration.

---

## 👥 For Users (Quick Extension Install)

Since the extension is currently in development and not yet published on the official web stores, you can download and run it manually in your browser.

### 1. Download the Extension Package
* Go to the **Releases** section of this GitHub repository.
* Download either:
  * **`privacyai-shield-chrome.zip`** (for Chrome, Edge, Brave, Opera, etc.)
  * **`privacyai-shield-firefox.zip`** (for Firefox)
* Extract (unzip) the file to a folder on your computer.

### 2. Install in Chrome / Chromium-based Browsers
1. Open Chrome and go to `chrome://extensions/`.
2. Turn on **Developer mode** (top-right toggle switch).
3. Click the **Load unpacked** button in the top-left.
4. Select the extracted folder containing the extension files.

### 3. Install in Firefox
1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox** on the left menu.
3. Click the **Load Temporary Add-on...** button.
4. Select the `manifest.json` file inside your extracted Firefox folder (or select the `.zip` file directly).

---

## 💻 For Developers (SDK & Extension Setup)

PrivacyAI uses a monorepo workspace managed by `pnpm`.

### 1. Setup the Project
Install dependencies, configure your local environment, and setup your chosen AI provider (Ollama, LM Studio, OpenAI, or Gemini):

```bash
npm run setup
```
*(This script works on macOS, Linux, and Windows).*

### 2. Build the Workspace
To build the SDK and the browser extension:

```bash
# Build the SDK and Chrome Extension
pnpm --filter @privacy-ai/browser-extension build

# Post-process for Firefox compatibility
pnpm --filter @privacy-ai/browser-extension build:firefox
```

### 3. Try the Web Demo
Spin up a local web page that demonstrates prompt sanitization in action:

```bash
npm run demo
```
Open your browser to `http://localhost:3000`.

### 4. Run the Tests
Verify the code integrity by running the test suites:

```bash
# Run SDK unit tests
pnpm -F @privacy-ai/sdk test

# Run Browser Extension E2E tests (requires Playwright)
pnpm -F @privacy-ai/browser-extension test:e2e
```

---

## 📦 SDK Quick Start

You can also use the core library directly in your own JavaScript/Node projects:

```javascript
import { PrivacySanitizer } from "@privacy-ai/sdk";

const sanitizer = new PrivacySanitizer({ provider: 'regex' });
const { safePrompt, sessionMap } = await sanitizer.sanitize(
  "Hello, my email is jane@example.com."
);

console.log(safePrompt);
// "Hello, my email is [EMAIL_1]."
```

---

## 📂 Project References

* **SDK Library:** [packages/sdk/README.md](packages/sdk/README.md)
* **Web Demo:** [apps/web-demo/README.md](apps/web-demo/README.md)
* **Extension Source:** [apps/browser-extension/README.md](apps/browser-extension/README.md)
* **Architecture Docs:** [docs/architecture.md](docs/architecture.md)
* **Code Examples:** [examples/README.md](examples/README.md)