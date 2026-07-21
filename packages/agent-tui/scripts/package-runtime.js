import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(scriptPath));
const repositoryRoot = dirname(dirname(packageRoot));
const bridgeRoot = join(repositoryRoot, "packages", "agent-bridge");
const bridgeManifestPath = join(bridgeRoot, "package.json");
const sdkManifestPath = join(repositoryRoot, "packages", "sdk", "package.json");
const manifestPath = join(packageRoot, "package.json");
const backupPath = join(packageRoot, ".privacyai-package.json.pack-backup");
const watchPath = join(packageRoot, ".privacyai-package-watch");
const vendorRoot = join(packageRoot, "vendor");
const destinationRoot = join(vendorRoot, "agent-bridge");
const temporaryRoot = join(vendorRoot, ".agent-bridge-tmp-" + process.pid);
const action = process.argv[2];

if (action === "pack") {
  await pack();
} else if (action === "lifecycle") {
  await prepareForPublish();
} else if (action === "clean") {
  await cleanup();
} else if (action === "watch") {
  await watchParent(Number(process.argv[3]), process.argv[4]);
} else {
  throw new Error("Usage: node scripts/package-runtime.js <pack|lifecycle|clean|watch>");
}

async function prepareForPublish() {
  if (process.env.npm_command !== "publish") {
    throw new Error("Use `npm run pack:production -- [npm pack options]` to package PrivacyAI safely.");
  }
  installSignalCleanup();
  try {
    await prepare();
    await startCleanupWatcher(findNpmProcessId(), randomUUID());
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function prepare() {
  await restoreManifestIfPresent();
  await rm(vendorRoot, { recursive: true, force: true });

  const originalManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(originalManifest);
  const bridgeManifest = JSON.parse(await readFile(bridgeManifestPath, "utf8"));
  const sdkManifest = JSON.parse(await readFile(sdkManifestPath, "utf8"));
  const bridgeSpecifier = manifest.dependencies?.["@privacy-ai/agent-bridge"];
  const sdkSpecifier = manifest.dependencies?.["@privacy-ai/sdk"];
  const expectedWorkspaceSpecifier = `workspace:${manifest.version}`;
  if (bridgeManifest.version !== manifest.version || sdkManifest.version !== manifest.version) {
    throw new Error(
      "PrivacyAI release versions must match across the SDK, bridge, and CLI packages."
    );
  }
  if (
    bridgeSpecifier !== expectedWorkspaceSpecifier ||
    sdkSpecifier !== expectedWorkspaceSpecifier ||
    bridgeManifest.dependencies?.["@privacy-ai/sdk"] !== expectedWorkspaceSpecifier
  ) {
    throw new Error(
      `PrivacyAI internal dependencies must use ${expectedWorkspaceSpecifier}.`
    );
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error("PrivacyAI CLI packaging requires an explicit files allowlist.");
  }
  const requiredFiles = ["README.md", "bin", "src", "vendor"];
  if (requiredFiles.some(entry => !manifest.files.includes(entry))) {
    throw new Error(
      `PrivacyAI CLI files must include: ${requiredFiles.join(", ")}.`
    );
  }

  delete manifest.dependencies["@privacy-ai/agent-bridge"];
  manifest.dependencies["@privacy-ai/sdk"] = sdkManifest.version;
  delete manifest.scripts;
  manifest.files = manifest.files.filter(entry => entry !== "scripts");
  await writeFile(backupPath, originalManifest, { flag: "wx", mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });

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
}

async function pack() {
  installSignalCleanup();
  let exitCode = 1;
  try {
    await prepare();
    exitCode = await runNpmPack(process.argv.slice(3));
  } finally {
    await cleanup();
  }
  process.exitCode = exitCode;
}

function runNpmPack(args) {
  return new Promise((resolve, reject) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["pack", "--ignore-scripts", ...args], {
      cwd: packageRoot,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error("npm pack stopped by " + signal + "."));
      else resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

function findNpmProcessId() {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const info = processInfo(pid);
    if (!info) break;
    if (isNpmCommand(info.command)) return pid;
    pid = info.parentPid;
  }
  throw new Error("PrivacyAI packaging could not identify the npm publish process.");
}

function processInfo(pid) {
  const result = spawnSync(
    "ps",
    ["-o", "ppid=", "-o", "command=", "-p", String(pid)],
    { encoding: "utf8" }
  );
  if (result.status !== 0) return null;

  const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/s);
  if (!match) return null;
  return { parentPid: Number(match[1]), command: match[2] };
}

function isNpmCommand(command) {
  return /(?:^|[\s/])npm(?:-cli\.js)?(?:\s|$)/.test(command);
}

async function startCleanupWatcher(parentPid, token) {
  await rm(watchPath, { force: true });
  const child = spawn(
    process.execPath,
    [scriptPath, "watch", String(parentPid), token],
    { cwd: packageRoot, detached: true, stdio: "ignore" }
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  try {
    await waitForWatcherReady(token);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  child.unref();
}

async function waitForWatcherReady(token) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await readWatchToken() === token) return;
    await delay(20);
  }
  throw new Error("PrivacyAI packaging cleanup watcher did not start.");
}

async function watchParent(parentPid, token) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || !isWatchToken(token)) {
    throw new TypeError("Cleanup watcher requires a valid parent process and token.");
  }
  await writeFile(watchPath, token, { flag: "wx", mode: 0o600 });
  while (processIsAlive(parentPid)) await delay(100);
  await cleanup(token);
}

function isWatchToken(token) {
  return typeof token === "string" && /^[a-f0-9-]{36}$/i.test(token);
}

async function readWatchToken() {
  try {
    return await readFile(watchPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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

async function cleanup(expectedToken = null) {
  if (expectedToken && await readWatchToken() !== expectedToken) return;
  await rm(watchPath, { force: true });

  let originalManifest;
  try {
    originalManifest = await readFile(backupPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await rm(vendorRoot, { recursive: true, force: true });
  await writeFile(manifestPath, originalManifest, { mode: 0o644 });
  await rm(backupPath, { force: true });
}

async function restoreManifestIfPresent() {
  await rm(watchPath, { force: true });

  let originalManifest;
  try {
    originalManifest = await readFile(backupPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await rm(vendorRoot, { recursive: true, force: true });
  await writeFile(manifestPath, originalManifest, { mode: 0o644 });
  await rm(backupPath, { force: true });
}
