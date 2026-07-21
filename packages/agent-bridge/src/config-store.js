import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

import {
  DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS,
  createPrivacyError,
  normalizeClassifierConcurrency,
  normalizeLocalModelContextTokens,
  normalizeOllamaKeepAlive
} from "@privacy-ai/sdk";

const CONFIG_VERSION = 1;

export function defaultConfigPath() {
  return resolve(
    process.env.PRIVACYAI_CONFIG_FILE ||
      join(
        process.env.PRIVACYAI_CONFIG_DIR || join(homedir(), ".config", "privacyai"),
        "config.json"
      )
  );
}

export async function loadPrivacyConfig(options = {}) {
  const path = resolve(options.path || defaultConfigPath());
  try {
    validatePrivateConfigMetadata(await lstat(path));
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, path, config: null };
    throw configStorageError(error, "storage_read");
  }

  let storage;
  try {
    storage = await openConfigStorage(path, { create: false });
    const parsed = JSON.parse(await readPrivateConfig(storage));
    return { configured: true, path, config: normalizeConfig(parsed) };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, path, config: null };
    throw configStorageError(error, "storage_read");
  } finally {
    await storage?.directoryHandle.close().catch(() => {});
  }
}

export async function savePrivacyConfig(config, options = {}) {
  const path = resolve(options.path || defaultConfigPath());
  const normalized = normalizeConfig(config);
  let storage;
  let tempPath;

  try {
    storage = await openConfigStorage(path, { create: true });
    await assertReplaceableConfigTarget(storage);
    tempPath = join(
      storage.operationDirectoryPath,
      `${storage.fileName}.${process.pid}.${randomUUID()}.tmp`
    );
    await writePrivateConfig(tempPath, normalized, storage);
    await assertConfigStorageStable(storage);
    await rename(tempPath, storage.filePath);
    await assertPrivateConfig(storage);
    tempPath = null;
    await syncHandle(storage.directoryHandle);
    return { path, config: normalized };
  } catch (error) {
    throw configStorageError(error, "storage_write");
  } finally {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    await storage?.directoryHandle.close().catch(() => {});
  }
}

export function normalizeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PrivacyAI configuration must be an object.");
  }

  const provider = String(value.provider || "ollama").trim();
  const model = String(value.model || "").trim();
  const baseURL = String(value.baseURL || "").trim().replace(/\/+$/, "");

  if (!model) throw new TypeError("PrivacyAI configuration requires a model.");
  if (!baseURL) throw new TypeError("PrivacyAI configuration requires a baseURL.");
  if (!new Set(["ollama", "lm-studio", "openai-compatible"]).has(provider)) {
    throw new TypeError(`Unsupported PrivacyAI provider: ${provider}`);
  }
  assertLocalPrivacyEndpoint(baseURL);

  const numCtx = normalizeLocalModelContextTokens(
    value.numCtx,
    DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS
  );
  const fallbackNumCtx = normalizeFallbackContext(value.fallbackNumCtx, numCtx);

  return {
    version: CONFIG_VERSION,
    provider,
    model,
    baseURL,
    apiKey: typeof value.apiKey === "string" && value.apiKey ? value.apiKey : "not-required",
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : 60000,
    numCtx,
    fallbackNumCtx,
    keepAlive: normalizeOllamaKeepAlive(value.keepAlive, DEFAULT_OLLAMA_KEEP_ALIVE),
    classifierConcurrency: normalizeClassifierConcurrency(value.classifierConcurrency),
    onboardedAt: value.onboardedAt || new Date().toISOString()
  };
}

function normalizeFallbackContext(value, numCtx) {
  if (value != null) {
    const fallback = normalizeLocalModelContextTokens(value);
    if (fallback >= numCtx) {
      throw new TypeError("fallbackNumCtx must be smaller than numCtx.");
    }
    return fallback;
  }
  if (numCtx <= 2048) return null;
  return Math.min(
    OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS,
    Math.max(2048, Math.floor(numCtx * 0.75))
  );
}

async function openConfigStorage(path, options) {
  if (process.platform === "win32") {
    throw new Error("PrivacyAI configuration storage requires Linux or macOS.");
  }

  const directoryPath = dirname(path);
  await ensureDirectoryComponents(directoryPath, options.create === true);
  const pathMetadata = await lstat(directoryPath);
  validateConfigDirectory(pathMetadata, { final: true });

  let directoryHandle;
  try {
    const flags = constants.O_RDONLY |
      (constants.O_DIRECTORY || 0) |
      (constants.O_NOFOLLOW || 0);
    directoryHandle = await open(directoryPath, flags);
    const openedMetadata = await directoryHandle.stat();
    validateConfigDirectory(openedMetadata, { final: true });
    if (!sameFile(pathMetadata, openedMetadata)) {
      throw new Error("PrivacyAI configuration directory changed during access.");
    }

    await validateDirectoryComponents(directoryPath);
    if (!sameFile(await lstat(directoryPath), openedMetadata)) {
      throw new Error("PrivacyAI configuration directory changed during access.");
    }

    const operationDirectoryPath = await configDirectoryOperationPath(
      directoryHandle,
      openedMetadata,
      directoryPath
    );
    const fileName = basename(path);
    return {
      directoryHandle,
      directoryPath,
      directoryMetadata: openedMetadata,
      operationDirectoryPath,
      fileName,
      filePath: join(operationDirectoryPath, fileName)
    };
  } catch (error) {
    await directoryHandle?.close().catch(() => {});
    throw error;
  }
}

async function ensureDirectoryComponents(path, create) {
  const components = directoryComponents(path);
  for (const [index, component] of components.entries()) {
    const final = index === components.length - 1;
    try {
      await validateConfigPathComponent(component, await lstat(component), { final });
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      try {
        await mkdir(component, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      await validateConfigPathComponent(component, await lstat(component), { final });
    }
  }
  await validateDirectoryComponents(path);
}

async function validateDirectoryComponents(path) {
  const components = directoryComponents(path);
  for (const [index, component] of components.entries()) {
    await validateConfigPathComponent(component, await lstat(component), {
      final: index === components.length - 1
    });
  }
}

function directoryComponents(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = [root];
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    components.push(current);
  }
  return components;
}

async function validateConfigPathComponent(path, metadata, options = {}) {
  if (!metadata.isSymbolicLink()) {
    validateConfigDirectory(metadata, options);
    return;
  }
  if (options.final || !await isTrustedSystemDirectorySymlink(path, metadata)) {
    throw new Error("PrivacyAI configuration path contains an unsafe filesystem entry.");
  }
}

async function isTrustedSystemDirectorySymlink(path, metadata) {
  if (typeof process.getuid !== "function" || metadata.uid !== 0) return false;
  const [parentMetadata, targetMetadata] = await Promise.all([
    stat(dirname(path)),
    stat(path)
  ]);
  return (
    parentMetadata.isDirectory() &&
    parentMetadata.uid === 0 &&
    (parentMetadata.mode & 0o022) === 0 &&
    targetMetadata.isDirectory() &&
    targetMetadata.uid === 0 &&
    (targetMetadata.mode & 0o022) === 0
  );
}

function validateConfigDirectory(metadata, options = {}) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("PrivacyAI configuration path contains an unsafe filesystem entry.");
  }
  if (!options.final) return;
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("PrivacyAI configuration directory is not owned by the current user.");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("PrivacyAI configuration directory is writable by another user.");
  }
}

async function configDirectoryOperationPath(directoryHandle, directoryMetadata, directoryPath) {
  if (process.platform === "darwin") {
    // macOS /dev/fd duplicates descriptors but does not provide openat-style traversal.
    // File creation is validated against the held directory before any private bytes are written.
    return directoryPath;
  }
  if (process.platform !== "linux") {
    throw new Error("PrivacyAI configuration storage requires Linux or macOS.");
  }
  for (const candidate of [
    "/proc/self/fd/" + directoryHandle.fd,
    "/dev/fd/" + directoryHandle.fd
  ]) {
    try {
      if (sameFile(await stat(candidate), directoryMetadata)) return candidate;
    } catch {
      // Try the next Linux descriptor namespace.
    }
  }
  throw new Error("PrivacyAI configuration storage requires descriptor-relative access.");
}

async function assertReplaceableConfigTarget(storage) {
  await assertConfigStorageStable(storage);
  try {
    validatePrivateConfigMetadata(
      await lstat(join(storage.directoryPath, storage.fileName))
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await assertConfigStorageStable(storage);
}

async function readPrivateConfig(storage) {
  await assertConfigStorageStable(storage);
  const handle = await open(
    storage.filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
  );
  try {
    const openedMetadata = await handle.stat();
    validatePrivateConfigMetadata(openedMetadata);
    const pathMetadata = await lstat(join(storage.directoryPath, storage.fileName));
    validatePrivateConfigMetadata(pathMetadata);
    if (!sameFile(openedMetadata, pathMetadata)) {
      throw new Error("PrivacyAI configuration file changed during access.");
    }
    await assertConfigStorageStable(storage);
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writePrivateConfig(path, config, storage) {
  let handle;
  try {
    const flags = constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0);
    handle = await open(path, flags, 0o600);
    await assertConfigStorageStable(storage);
    await handle.writeFile(JSON.stringify(config, null, 2) + "\n", "utf8");
    await handle.chmod(0o600);
    await syncHandle(handle);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertPrivateConfig(storage) {
  await assertConfigStorageStable(storage);
  const handle = await open(
    storage.filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
  );
  try {
    const openedMetadata = await handle.stat();
    validatePrivateConfigMetadata(openedMetadata);
    const pathMetadata = await lstat(join(storage.directoryPath, storage.fileName));
    validatePrivateConfigMetadata(pathMetadata);
    if (!sameFile(openedMetadata, pathMetadata)) {
      throw new Error("PrivacyAI configuration file changed during access.");
    }
    await assertConfigStorageStable(storage);
  } finally {
    await handle.close().catch(() => {});
  }
}

function validatePrivateConfigMetadata(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("PrivacyAI configuration must be one regular file.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("PrivacyAI configuration is not owned by the current user.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("PrivacyAI configuration permissions expose credentials.");
  }
}

async function assertConfigStorageStable(storage) {
  await validateDirectoryComponents(storage.directoryPath);
  const pathMetadata = await lstat(storage.directoryPath);
  const openedMetadata = await storage.directoryHandle.stat();
  validateConfigDirectory(pathMetadata, { final: true });
  validateConfigDirectory(openedMetadata, { final: true });
  if (
    !sameFile(pathMetadata, storage.directoryMetadata) ||
    !sameFile(openedMetadata, storage.directoryMetadata)
  ) {
    throw new Error("PrivacyAI configuration directory changed during access.");
  }
}

async function syncHandle(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EINVAL" && error?.code !== "ENOTSUP") throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function configStorageError(error, phase) {
  if (error?.code === "PRIVACYAI_CONFIG_INVALID") return error;
  return createPrivacyError({
    code: "PRIVACYAI_CONFIG_INVALID",
    category: "storage",
    phase,
    message: "PrivacyAI configuration is invalid or unreadable.",
    publicMessage: "PrivacyAI configuration is invalid or unreadable.",
    cause: error
  });
}

export function assertLocalPrivacyEndpoint(baseURL, options = {}) {
  const allowRemote =
    options.allowRemote === true || process.env.PRIVACYAI_ALLOW_REMOTE_SANITIZER === "1";
  if (allowRemote) return;

  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new TypeError("PrivacyAI baseURL must be a valid URL.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const isIpv4Loopback =
    isIP(unbracketedHostname) === 4 && unbracketedHostname.split(".")[0] === "127";
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIpv4Loopback ||
    unbracketedHostname === "::1";

  if (!isLoopback) {
    throw new TypeError(
      "PrivacyAI refuses a remote sanitizer endpoint by default because raw prompts are sent to the sanitizer. " +
        "Use a loopback address, or explicitly set PRIVACYAI_ALLOW_REMOTE_SANITIZER=1."
    );
  }
}
