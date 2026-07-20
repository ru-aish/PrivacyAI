import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

import {
  createPrivacyIdentityService,
  generatePrivacyIdentityKey,
  privacyIdentityKeyId
} from "@privacy-ai/sdk/identity";

const INSTALLATION_KEY_VERSION = 1;
const INSTALLATION_KEY_BYTES = 32;

export function defaultPrivacyIdentityKeyPath(options = {}) {
  return privacyIdentityKeyLocation(options).path;
}

export async function loadInstallationPrivacyIdentity(options = {}) {
  const location = privacyIdentityKeyLocation(options);
  return withIdentityStorage(location, { create: false }, async storage => {
    const identityRoot = identityFromRecord(await readIdentityRecord(storage.keyPath));
    await cleanupIdentityTempFiles(storage);
    return identityRoot;
  });
}

export async function openInstallationPrivacyIdentity(options = {}) {
  if (isPrivacyIdentityService(options.identityRoot)) return options.identityRoot;
  if (options.identityKey instanceof Uint8Array) {
    return createPrivacyIdentityService({ key: options.identityKey });
  }

  const location = privacyIdentityKeyLocation(options);
  return withIdentityStorage(location, { create: true }, async storage => {
    try {
      const identityRoot = identityFromRecord(await readIdentityRecord(storage.keyPath));
      await cleanupIdentityTempFiles(storage);
      return identityRoot;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const record = installationKeyRecord(generatePrivacyIdentityKey());
    const tempPath = identityTempPath(storage);
    try {
      await writePrivateIdentityRecord(tempPath, record);
      await assertIdentityStorageStable(storage);
      try {
        await link(tempPath, storage.keyPath);
      } catch (error) {
        // A concurrent winner may publish the final record and remove all stale
        // temporary names before this process reaches link(). In both cases the
        // final record is the only source of truth.
        if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
      }

      let identityRoot;
      try {
        identityRoot = identityFromRecord(await readIdentityRecord(storage.keyPath));
      } catch (error) {
        if (error?.code === "ENOENT") throw identityStoreError(error);
        throw error;
      }
      await cleanupIdentityTempFiles(storage);
      return identityRoot;
    } catch (error) {
      if (
        error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT" ||
        error?.code === "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE"
      ) {
        throw error;
      }
      throw identityStoreError(error);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  });
}

export async function rotateInstallationPrivacyIdentityKey(options = {}) {
  const location = privacyIdentityKeyLocation(options);
  return withIdentityStorage(location, { create: true }, async storage => {
    let previousKeyId = null;
    try {
      const previousRecord = await readIdentityRecord(storage.keyPath);
      identityFromRecord(previousRecord);
      previousKeyId = previousRecord.keyId;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const record = installationKeyRecord(generatePrivacyIdentityKey());
    const tempPath = identityTempPath(storage);
    try {
      await writePrivateIdentityRecord(tempPath, record);
      await assertIdentityStorageStable(storage);
      await rename(tempPath, storage.keyPath);
      const identityRoot = identityFromRecord(await readIdentityRecord(storage.keyPath));
      await cleanupIdentityTempFiles(storage);
      return {
        path: location.path,
        previousKeyId,
        keyId: record.keyId,
        identityRoot
      };
    } catch (error) {
      if (error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT") throw error;
      throw identityStoreError(error);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  });
}

export function sessionPrivacyIdentity(identityRoot, sessionKey) {
  requireIdentityRoot(identityRoot);
  const lineageId = identityRoot.reference("lineage", {
    version: 1,
    sessionKey: requiredScopeInput(sessionKey, "session key")
  });
  return identityRoot.forScope({ kind: "session", id: lineageId });
}

export function requestPrivacyIdentity(identityRoot, requestId) {
  requireIdentityRoot(identityRoot);
  const id = identityRoot.reference("request-scope", {
    version: 1,
    requestId: requiredScopeInput(requestId, "request id")
  });
  return identityRoot.forScope({ kind: "request", id });
}

export function documentPrivacyIdentity(identityRoot, documentId) {
  requireIdentityRoot(identityRoot);
  const id = identityRoot.reference("document-scope", {
    version: 1,
    documentId: requiredScopeInput(documentId, "document id")
  });
  return identityRoot.forScope({ kind: "document", id });
}

export function policyPrivacyIdentity(identityRoot, policyId) {
  requireIdentityRoot(identityRoot);
  const id = identityRoot.reference("policy-scope", {
    version: 1,
    policyId: requiredScopeInput(policyId, "policy id")
  });
  return identityRoot.forScope({ kind: "policy", id });
}

export function deterministicProviderIdentifier(identity, provider, original, occupied = new Set()) {
  const normalizedProvider = String(provider || "").toLocaleLowerCase("en-US");
  const prefix = normalizedProvider === "agy"
    ? "privacyai_tool_"
    : normalizedProvider === "codex"
      ? "privacyai_"
      : null;
  if (!prefix) throw new TypeError("Unsupported PrivacyAI provider identity domain: " + provider);
  const normalizedOriginal = requiredScopeInput(original, "provider identifier");
  if (!identity || typeof identity.digest !== "function") {
    const error = new TypeError(
      "PrivacyAI provider identifiers require an infrastructure-owned privacy identity."
    );
    error.code = "PRIVACYAI_IDENTITY_REQUIRED";
    throw error;
  }
  const digest = identity.digest("provider-identifier:" + normalizedProvider, {
    version: 1,
    original: normalizedOriginal
  });
  const unavailable = new Set(
    [...(occupied instanceof Set ? occupied : new Set(occupied || []))]
      .map(value => String(value).toLocaleLowerCase("en-US"))
  );
  const maximumDigestLength = normalizedProvider === "codex" ? 52 : 64;
  for (let length = 12; length <= maximumDigestLength; length += 4) {
    const candidate = prefix + digest.slice(0, length);
    if (!unavailable.has(candidate)) return candidate;
  }
  const error = new Error("PrivacyAI could not allocate a collision-free provider identifier.");
  error.code = "PRIVACYAI_IDENTITY_COLLISION";
  throw error;
}

export function privacyIdentityMetadata(identity, sessionMap = {}) {
  if (!identity || typeof identity.describeSessionMap !== "function") {
    const error = new TypeError(
      "PrivacyAI session metadata requires an infrastructure-owned privacy identity."
    );
    error.code = "PRIVACYAI_IDENTITY_REQUIRED";
    throw error;
  }
  return {
    identityKeyId: identity.keyId,
    identityScope: identity.scope,
    identityMap: identity.describeSessionMap(sessionMap, {
      domainForAlias: alias => identityDomainForAlias(alias)
    })
  };
}

export function identityDomainForAlias(alias) {
  const value = String(alias || "");
  return /^(?:privacyai(?:_v1)?_tool_[a-f0-9]{12,64}|privacyai_[a-f0-9]{12,64}(?:_\d+)?)$/i.test(value)
    ? "provider-identifier"
    : "text";
}

function installationKeyRecord(key) {
  return {
    version: INSTALLATION_KEY_VERSION,
    algorithm: "HMAC-SHA-256",
    keyId: privacyIdentityKeyId(key),
    key: Buffer.from(key).toString("base64"),
    createdAt: new Date().toISOString()
  };
}

function privacyIdentityKeyLocation(options = {}) {
  if (options.identityKeyPath) {
    return { path: resolve(options.identityKeyPath), privateDirectory: false };
  }
  if (process.env.PRIVACYAI_IDENTITY_KEY_FILE) {
    return { path: resolve(process.env.PRIVACYAI_IDENTITY_KEY_FILE), privateDirectory: false };
  }
  if (options.identityBaseDir) {
    return {
      path: join(resolve(options.identityBaseDir), "key-v1.json"),
      privateDirectory: true
    };
  }
  if (options.baseDir) {
    return {
      path: join(resolve(options.baseDir), ".privacyai-identity-key-v1.json"),
      privateDirectory: false
    };
  }
  return {
    path: join(homedir(), ".local", "share", "privacyai", "identity", "key-v1.json"),
    privateDirectory: true
  };
}

async function withIdentityStorage(location, options, operation) {
  const storage = await openIdentityStorage(location, options);
  try {
    const result = await operation(storage);
    await assertIdentityStorageStable(storage);
    return result;
  } finally {
    await storage.directoryHandle.close().catch(() => {});
  }
}

async function openIdentityStorage(location, options) {
  const directoryPath = dirname(location.path);
  await ensureDirectoryComponents(directoryPath, options);
  const pathMetadata = await lstat(directoryPath);
  validateIdentityDirectory(pathMetadata, { final: true });

  let directoryHandle;
  try {
    const flags = constants.O_RDONLY |
      (process.platform === "win32" ? 0 : ((constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)));
    directoryHandle = await open(directoryPath, flags);
    let openedMetadata = await directoryHandle.stat();
    validateIdentityDirectory(openedMetadata, { final: true });
    if (!sameFile(pathMetadata, openedMetadata)) throw corruptIdentityStoreError();

    if (location.privateDirectory && process.platform !== "win32") {
      await directoryHandle.chmod(0o700);
      openedMetadata = await directoryHandle.stat();
      if ((openedMetadata.mode & 0o777) !== 0o700) throw corruptIdentityStoreError();
    } else if (
      !location.privateDirectory &&
      process.platform !== "win32" &&
      (openedMetadata.mode & 0o022) !== 0
    ) {
      throw corruptIdentityStoreError();
    }

    await validateDirectoryComponents(directoryPath);
    const currentMetadata = await lstat(directoryPath);
    if (!sameFile(currentMetadata, openedMetadata)) throw corruptIdentityStoreError();

    let operationDirectoryPath = directoryPath;
    if (process.platform === "linux") {
      const descriptorPath = `/proc/self/fd/${directoryHandle.fd}`;
      try {
        await lstat(descriptorPath);
        operationDirectoryPath = descriptorPath;
      } catch {
        // Minimal containers may not mount procfs. Component and inode checks
        // remain active for the path-based fallback.
      }
    }
    return {
      directoryHandle,
      directoryPath,
      directoryMetadata: openedMetadata,
      operationDirectoryPath,
      keyName: basename(location.path),
      keyPath: join(operationDirectoryPath, basename(location.path))
    };
  } catch (error) {
    await directoryHandle?.close().catch(() => {});
    if (error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT") throw error;
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw corruptIdentityStoreError(error);
    }
    throw error;
  }
}

async function ensureDirectoryComponents(path, options) {
  for (const component of directoryComponents(path)) {
    try {
      validateIdentityDirectory(await lstat(component));
    } catch (error) {
      if (error?.code !== "ENOENT" || !options.create) throw directoryStoreError(error);
      try {
        await mkdir(component, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw directoryStoreError(mkdirError);
      }
      validateIdentityDirectory(await lstat(component));
    }
  }
  await validateDirectoryComponents(path);
}

async function validateDirectoryComponents(path) {
  for (const component of directoryComponents(path)) {
    validateIdentityDirectory(await lstat(component));
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

function validateIdentityDirectory(metadata, options = {}) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw corruptIdentityStoreError();
  }
  if (options.final) validateIdentityDirectoryOwner(metadata);
}

function validateIdentityDirectoryOwner(metadata) {
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw corruptIdentityStoreError();
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertIdentityStorageStable(storage) {
  try {
    await validateDirectoryComponents(storage.directoryPath);
    const pathMetadata = await lstat(storage.directoryPath);
    const openedMetadata = await storage.directoryHandle.stat();
    validateIdentityDirectory(pathMetadata, { final: true });
    validateIdentityDirectory(openedMetadata, { final: true });
    if (
      !sameFile(pathMetadata, storage.directoryMetadata) ||
      !sameFile(openedMetadata, storage.directoryMetadata)
    ) {
      throw corruptIdentityStoreError();
    }
  } catch (error) {
    if (error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT") throw error;
    throw corruptIdentityStoreError(error);
  }
}

function identityTempPath(storage) {
  return join(
    storage.operationDirectoryPath,
    `${storage.keyName}.${process.pid}.${randomUUID()}.tmp`
  );
}

async function writePrivateIdentityRecord(path, record) {
  let handle;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW || 0));
    handle = await open(path, flags, 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function cleanupIdentityTempFiles(storage) {
  let entries;
  try {
    entries = await readdir(storage.operationDirectoryPath, { withFileTypes: true });
  } catch {
    return;
  }
  const prefix = storage.keyName + ".";
  await Promise.all(entries.map(async entry => {
    if (
      !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(".tmp") ||
      (!entry.isFile() && !entry.isSymbolicLink())
    ) {
      return;
    }
    await rm(join(storage.operationDirectoryPath, entry.name), { force: true }).catch(() => {});
  }));
}

async function readIdentityRecord(path) {
  let handle;
  let value;
  try {
    const pathMetadata = await lstat(path);
    validateIdentityKeyFile(pathMetadata);
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW || 0));
    handle = await open(path, flags);
    const openedMetadata = await handle.stat();
    validateIdentityKeyFile(openedMetadata);
    if (!sameFile(pathMetadata, openedMetadata)) {
      throw corruptIdentityStoreError();
    }
    value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    if (error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT") throw error;
    throw corruptIdentityStoreError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corruptIdentityStoreError();
  }
  return value;
}

function validateIdentityKeyFile(metadata) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 16 * 1024 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw corruptIdentityStoreError();
  }
}

function identityFromRecord(record) {
  if (
    record.version !== INSTALLATION_KEY_VERSION ||
    record.algorithm !== "HMAC-SHA-256" ||
    typeof record.key !== "string" ||
    typeof record.keyId !== "string"
  ) {
    throw corruptIdentityStoreError();
  }
  const key = Buffer.from(record.key, "base64");
  if (
    key.length !== INSTALLATION_KEY_BYTES ||
    key.toString("base64") !== record.key
  ) {
    throw corruptIdentityStoreError();
  }
  const identityRoot = createPrivacyIdentityService({ key });
  if (!identityRoot.equal(identityRoot.keyId, record.keyId)) {
    throw corruptIdentityStoreError();
  }
  return identityRoot;
}

function requiredScopeInput(value, label) {
  const normalized = String(value || "");
  if (!normalized || normalized.length > 4096 || /[\0\r\n]/.test(normalized)) {
    throw new TypeError(`Privacy identity ${label} must be a non-empty opaque string.`);
  }
  return normalized;
}

function requireIdentityRoot(value) {
  if (!isPrivacyIdentityService(value)) {
    throw new TypeError("PrivacyAI requires an installation identity service.");
  }
}

function isPrivacyIdentityService(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.digest === "function" &&
    typeof value.reference === "function" &&
    typeof value.forScope === "function" &&
    typeof value.placeholder === "function"
  );
}

function corruptIdentityStoreError(cause) {
  const error = cause == null
    ? new Error("PrivacyAI identity key material is malformed.")
    : new Error("PrivacyAI identity key material is malformed.", { cause });
  error.code = "PRIVACYAI_IDENTITY_KEY_CORRUPT";
  return error;
}

function directoryStoreError(cause) {
  if (
    cause?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT" ||
    cause?.code === "ENOENT"
  ) {
    return cause;
  }
  if (cause?.code === "ELOOP" || cause?.code === "ENOTDIR") {
    return corruptIdentityStoreError(cause);
  }
  return cause;
}

function identityStoreError(cause) {
  const error = new Error("PrivacyAI could not persist installation identity key material.", { cause });
  error.code = "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE";
  return error;
}
