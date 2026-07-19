import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const manifestPath = path.join(__dirname, 'dist/manifest.json');
const firefoxReleaseContentMatches = new Set([
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://claude.ai/*",
  "https://gemini.google.com/*",
  "https://www.perplexity.ai/*",
  "https://copilot.microsoft.com/*",
  "https://poe.com/*"
]);
const firefoxReleaseHostPermissions = new Set([
  "http://127.0.0.1/*",
  "http://localhost/*"
]);

if (!fs.existsSync(manifestPath)) {
  console.error('Error: dist/manifest.json not found. Run build first.');
  process.exit(1);
}

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Firefox AMO reports content script matches as required site access and
  // host_permissions as optional site access. Do not list the chat sites in
  // both places, or the add-on page shows duplicate scary permission blocks.
  if (Array.isArray(manifest.host_permissions)) {
    manifest.host_permissions = manifest.host_permissions.filter((permission) =>
      firefoxReleaseHostPermissions.has(permission)
    );

    if (manifest.host_permissions.length === 0) {
      delete manifest.host_permissions;
    }
  }

  // Localhost and file pages are useful for tests/development, but they should
  // not be auto-injected in the Firefox release package.
  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts = manifest.content_scripts.map((script) => ({
      ...script,
      matches: Array.isArray(script.matches)
        ? script.matches.filter((match) => firefoxReleaseContentMatches.has(match))
        : script.matches
    }));
  }

  // 1. Convert background service_worker to background scripts for Firefox
  if (manifest.background) {
    if (manifest.background.service_worker) {
      manifest.background.scripts = [manifest.background.service_worker];
      delete manifest.background.service_worker;
      console.log('Swapped background.service_worker with background.scripts');
    }
  }

  // 2. Add browser_specific_settings.gecko.id (mandatory for Firefox MV3)
  manifest.browser_specific_settings = {
    gecko: {
      id: "shield@privacy-ai.org",
      strict_min_version: "142.0",
      data_collection_permissions: {
        required: ["none"]
      }
    }
  };
  console.log('Added Firefox specific settings (Gecko ID)');

  // Save the modified manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Successfully configured manifest.json for Firefox compatibility!');
} catch (error) {
  console.error('Failed to post-process manifest for Firefox:', error);
  process.exit(1);
}
