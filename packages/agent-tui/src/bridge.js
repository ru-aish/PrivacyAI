import { access } from "node:fs/promises";

const BRIDGE_PACKAGE = "@privacy-ai/agent-bridge";
const PACKED_BRIDGE_ROOT = new URL("../vendor/agent-bridge/", import.meta.url);
const DEVELOPMENT_BRIDGE_ROOT = new URL("../../agent-bridge/", import.meta.url);

let bridgeModulePromise;
let bridgeCliPromise;

export async function loadBridgeModule(override) {
  if (override) return override;
  bridgeModulePromise ||= importBridge(BRIDGE_PACKAGE, "src/index.js");
  return bridgeModulePromise;
}

export async function loadBridgeCli(override) {
  if (override) return override;
  bridgeCliPromise ||= importBridge(`${BRIDGE_PACKAGE}/cli`, "src/cli.js");
  return bridgeCliPromise;
}

async function importBridge(specifier, relativePath) {
  try {
    return await import(specifier);
  } catch (error) {
    if (!isMissingRequestedPackage(error)) throw error;
  }

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

function isMissingRequestedPackage(error) {
  return error?.code === "ERR_MODULE_NOT_FOUND" &&
    String(error.message || "").includes(BRIDGE_PACKAGE);
}
