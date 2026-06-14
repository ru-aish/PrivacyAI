import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const manifestPath = path.join(__dirname, 'dist/manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error('Error: dist/manifest.json not found. Run build first.');
  process.exit(1);
}

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

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
