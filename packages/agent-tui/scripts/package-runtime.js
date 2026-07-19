import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const bridgeRoot = join(repositoryRoot, "packages", "agent-bridge");
const sdkManifestPath = join(repositoryRoot, "packages", "sdk", "package.json");
const manifestPath = join(packageRoot, "package.json");
const backupPath = join(packageRoot, ".privacyai-package.json.pack-backup");
const vendorRoot = join(packageRoot, "vendor");
const destinationRoot = join(vendorRoot, "agent-bridge");
const temporaryRoot = join(vendorRoot, `.agent-bridge-tmp-${process.pid}`);
const action = process.argv[2];

if (action === "prepare") {
  installSignalCleanup();
  await restoreManifestIfPresent();
  await rm(vendorRoot, { recursive: true, force: true });

  const originalManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(originalManifest);
  const sdkManifest = JSON.parse(await readFile(sdkManifestPath, "utf8"));
  const bridgeSpecifier = manifest.dependencies?.["@privacy-ai/agent-bridge"];
  if (typeof bridgeSpecifier !== "string" || !bridgeSpecifier.startsWith("workspace:")) {
    throw new Error("PrivacyAI CLI prepack requires the internal workspace bridge dependency.");
  }

  manifest.dependencies = { "@privacy-ai/sdk": sdkManifest.version };
  delete manifest.scripts;
  await writeFile(backupPath, originalManifest, { flag: "wx", mode: 0o600 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  try {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o755 });
    await Promise.all([
      cp(join(bridgeRoot, "src"), join(temporaryRoot, "src"), { recursive: true }),
      cp(join(bridgeRoot, "bin"), join(temporaryRoot, "bin"), { recursive: true })
    ]);
    await rename(temporaryRoot, destinationRoot);
  } catch (error) {
    await cleanup();
    throw error;
  }
} else if (action === "clean") {
  await cleanup();
} else {
  throw new Error("Usage: node scripts/package-runtime.js <prepare|clean>");
}

function installSignalCleanup() {
  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]) {
    process.once(signal, () => {
      cleanup().finally(() => {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      });
    });
  }
}

async function cleanup() {
  await rm(vendorRoot, { recursive: true, force: true });
  await restoreManifestIfPresent();
}

async function restoreManifestIfPresent() {
  let originalManifest;
  try {
    originalManifest = await readFile(backupPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await writeFile(manifestPath, originalManifest, { mode: 0o644 });
  await rm(backupPath, { force: true });
}
