# 🛡️ PrivacyAI

PrivacyAI is a local-first privacy and sanitization layer that intercepts and redacts Personally Identifiable Information (PII), credentials, and sensitive data before they are sent to AI chat models (like ChatGPT, Claude, and Gemini).

It consists of a developer SDK (`@privacy-ai/sdk`), a browser extension to protect your daily chat workflows, and a local web demonstration.

---

## 👥 For Users (Quick Extension Install)

Firefox users can install PrivacyAI Shield from the official add-ons page: [PrivacyAI Shield on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/privacyai-shield/).

You can also download and run the extension manually in your browser.

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
Install from [PrivacyAI Shield on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/privacyai-shield/), or load a local build manually:

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox** on the left menu.
3. Click the **Load Temporary Add-on...** button.
4. Select the `manifest.json` file inside your extracted Firefox folder (or select the `.zip` file directly).

### Firefox Permission Notice
Firefox shows "Access your data" for the supported AI chat sites because the extension must run a content script on those pages to sanitize prompts before they are submitted. This is site access, not data collection.

The Firefox package declares no data collection through Mozilla's `data_collection_permissions` field. Localhost permissions are only used to talk to local model servers such as Ollama or LM Studio.

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
## Native Claude Code and Codex protection

PrivacyAI can wrap the user's existing agent CLI without proxying inference or
replacing its terminal interface:

```bash
npm install --global @privacy-ai/agent-tui
privacyai onboard
privacyai claude
privacyai codex
```

Onboarding scans both Ollama and a running LM Studio local server and lets the
user choose any usable downloaded language model. The original prompt is then
sanitized locally before the official CLI sends it. Placeholder values are then
restored recursively immediately before any hooked built-in, app, plugin, or MCP
tool executes, and known real values in successful tool results are sanitized
before returning to the task model. Claude hook-disabling modes are rejected,
and a failed Claude tool result containing a known original is stopped before a
next provider request. Native local session history may retain real values by
design; the remote provider receives the sanitized conversation. Current
support is Linux and macOS; file contents, project instructions, skills, and
other context injected before the prompt hook remain outside this boundary.
See `docs/native-agent-tui-wrapper.md` for the design and verified results.
