import { access } from "node:fs/promises";

const PACKED_BRIDGE_ROOT = new URL("../vendor/agent-bridge/", import.meta.url);
const DEVELOPMENT_BRIDGE_ROOT = new URL("../../agent-bridge/", import.meta.url);

let bridgeModulePromise;
let bridgeCliPromise;

export async function loadBridgeModule(override) {
  if (override) return override;
  bridgeModulePromise ||= importBridge("src/index.js");
  return bridgeModulePromise;
}

export async function loadBridgeCli(override) {
  if (override) return override;
  bridgeCliPromise ||= importBridge("src/cli.js");
  return bridgeCliPromise;
}

async function importBridge(relativePath) {
  // A published CLI and its runtime are one release unit. Always prefer the
  // vendored copy so an unrelated sibling installation cannot replace it.
  // The workspace sibling is only a source-tree development fallback.
  for (const root of [PACKED_BRIDGE_ROOT, DEVELOPMENT_BRIDGE_ROOT]) {
    const candidate = new URL(relativePath, root);
    try {
      await access(candidate);
    } catch {
      continue;
    }
    return import(candidate.href);
  }

  throw new Error(
    "PrivacyAI CLI is missing its internal agent runtime. Reinstall @privacy-ai/cli."
  );
}
