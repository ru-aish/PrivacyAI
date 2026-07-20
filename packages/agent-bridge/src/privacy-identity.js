import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

import {
  createPrivacyIdentityService,
  generatePrivacyIdentityKey,
  privacyIdentityKeyId
} from "@privacy-ai/sdk/identity";
import {
  isSameLiveProcess,
  readProcessStartIdentity
} from "./process-identity.js";

const INSTALLATION_KEY_VERSION = 1;
const INSTALLATION_KEY_BYTES = 32;
const IDENTITY_READ_RETRY_LIMIT = 8;
const IDENTITY_TEMP_MAX_UNKNOWN_OWNER_AGE_MS = 24 * 60 * 60 * 1000;
const IDENTITY_ROTATION_LOCK_WAIT_MS = 60_000;
const IDENTITY_ROTATION_LOCK_RETRY_MIN_MS = 10;
const IDENTITY_ROTATION_LOCK_RETRY_MAX_MS = 50;
const IDENTITY_ROTATION_LOCK_INCOMPLETE_GRACE_MS = 2_000;

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
  const storage = await openIdentityStorage(location, { create: true });
  let lock;
  let tempPath;
  let deferredRelease = false;
  try {
    try {
      const identityRoot = identityFromRecord(await readIdentityRecord(storage.keyPath));
      await cleanupIdentityTempFiles(storage);
      await assertIdentityStorageStable(storage);
      return identityRoot;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    lock = await acquireIdentityRotationLock(storage, options);
    throwIfIdentityMutationAborted(options.signal);
    try {
      const identityRoot = identityFromRecord(await readIdentityRecord(storage.keyPath));
      await cleanupIdentityTempFiles(storage);
      await assertIdentityStorageStable(storage);
      await lock.assertOwned();
      deferredRelease = true;
      deferIdentityMutationRelease(storage, lock);
      return identityRoot;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const record = installationKeyRecord(generatePrivacyIdentityKey());
    tempPath = await identityTempPath(storage);
    await writePrivateIdentityRecord(tempPath, record);
    await assertIdentityStorageStable(storage);
    await lock.assertOwned();
    throwIfIdentityMutationAborted(options.signal);
    try {
      await link(tempPath, storage.keyPath);
    } catch (error) {
      // A concurrent older runtime may have published a complete record without
      // participating in the mutation protocol. The final record remains the
      // only source of truth.
      if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
    }
    await lock.assertOwned();

    let identityRoot;
    try {
      identityRoot = identityFromRecord(await readIdentityRecord(storage.keyPath));
    } catch (error) {
      if (error?.code === "ENOENT") throw identityStoreError(error);
      throw error;
    }
    await cleanupIdentityTempFiles(storage);
    await assertIdentityStorageStable(storage);
    await lock.assertOwned();
    deferredRelease = true;
    deferIdentityMutationRelease(storage, lock);
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
    if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    if (!deferredRelease) {
      await lock?.release().catch(() => {});
      await storage.directoryHandle.close().catch(() => {});
    }
  }
}

export async function rotateInstallationPrivacyIdentityKey(options = {}) {
  const location = privacyIdentityKeyLocation(options);
  const storage = await openIdentityStorage(location, { create: true });
  let lock;
  let tempPath;
  let deferredRelease = false;
  try {
    lock = await acquireIdentityRotationLock(storage, options);
    throwIfIdentityMutationAborted(options.signal);
    let previousKeyId = null;
    try {
      const previousRecord = await readIdentityRecord(storage.keyPath);
      identityFromRecord(previousRecord);
      previousKeyId = previousRecord.keyId;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const key = generatePrivacyIdentityKey();
    const record = installationKeyRecord(key);
    tempPath = await identityTempPath(storage);
    await writePrivateIdentityRecord(tempPath, record);
    await assertIdentityStorageStable(storage);
    await lock.assertOwned();
    throwIfIdentityMutationAborted(options.signal);
    await rename(tempPath, storage.keyPath);
    tempPath = null;
    await lock.assertOwned();

    const installedRecord = await readIdentityRecord(storage.keyPath);
    const identityRoot = identityFromRecord(installedRecord);
    if (installedRecord.keyId !== record.keyId) throw changedIdentityStoreError();
    await cleanupIdentityTempFiles(storage);
    await assertIdentityStorageStable(storage);
    await lock.assertOwned();

    const result = {
      path: location.path,
      previousKeyId,
      keyId: identityRoot.keyId,
      identityRoot
    };
    deferredRelease = true;
    deferIdentityMutationRelease(storage, lock);
    return result;
  } catch (error) {
    if (
      error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT" ||
      error?.code === "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE"
    ) {
      throw error;
    }
    throw identityStoreError(error);
  } finally {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    if (!deferredRelease) {
      await lock?.release().catch(() => {});
      await storage.directoryHandle.close().catch(() => {});
    }
  }
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
  if (process.platform === "win32") throw windowsIdentityStorageUnavailableError();
  const directoryPath = dirname(location.path);
  await ensureDirectoryComponents(directoryPath, options);
  const pathMetadata = await lstat(directoryPath);
  validateIdentityDirectory(pathMetadata, { final: true });

  let directoryHandle;
  try {
    const flags = constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0);
    directoryHandle = await open(directoryPath, flags);
    let openedMetadata = await directoryHandle.stat();
    validateIdentityDirectory(openedMetadata, { final: true });
    if (!sameFile(pathMetadata, openedMetadata)) throw corruptIdentityStoreError();

    await validateDirectoryComponents(directoryPath);
    const currentMetadata = await lstat(directoryPath);
    if (!sameFile(currentMetadata, openedMetadata)) throw corruptIdentityStoreError();

    if (location.privateDirectory) {
      await directoryHandle.chmod(0o700);
      openedMetadata = await directoryHandle.stat();
      if ((openedMetadata.mode & 0o777) !== 0o700) throw corruptIdentityStoreError();
    } else if (
      !location.privateDirectory &&
      (openedMetadata.mode & 0o022) !== 0
    ) {
      throw corruptIdentityStoreError();
    }

    const operationDirectoryPath = await identityDirectoryDescriptorPath(
      directoryHandle,
      openedMetadata
    );
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

async function identityDirectoryDescriptorPath(directoryHandle, directoryMetadata) {
  const candidates = process.platform === "linux"
    ? [`/proc/self/fd/${directoryHandle.fd}`, `/dev/fd/${directoryHandle.fd}`]
    : [`/dev/fd/${directoryHandle.fd}`, `/proc/self/fd/${directoryHandle.fd}`];
  for (const candidate of candidates) {
    try {
      if (sameFile(await stat(candidate), directoryMetadata)) return candidate;
    } catch {
      // Try the next platform descriptor namespace.
    }
  }
  throw identityStoreError(new Error("Identity storage requires descriptor-relative filesystem access."));
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

async function identityTempPath(storage) {
  const processStart = await readProcessStartIdentity(process.pid);
  return join(
    storage.operationDirectoryPath,
    `${storage.keyName}.${process.pid}.${processStart || "unknown"}.${randomUUID()}.tmp`
  );
}

async function writePrivateIdentityRecord(path, record) {
  let handle;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      (constants.O_NOFOLLOW || 0);
    handle = await open(path, flags, 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function acquireIdentityRotationLock(storage, options = {}) {
  const signal = identityMutationSignal(options.signal);
  throwIfIdentityMutationAborted(signal);
  const timeoutMs = identityRotationLockTimeout(options.identityRotationLockTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  const processStart = await readProcessStartIdentity(process.pid);
  const token = randomUUID();
  const name = `${storage.keyName}.rotation.${process.pid}.${processStart || "unknown"}.${token}.lock`;
  const path = join(storage.operationDirectoryPath, name);
  let serialized = serializeIdentityRotationParticipant({
    pid: process.pid,
    processStart,
    token,
    choosing: true,
    ticket: null
  });

  try {
    await writePrivateIdentityLock(path, serialized);
    const participants = await readIdentityRotationParticipants(storage);
    const maximumTicket = participants.reduce(
      (maximum, participant) => participant.record?.choosing
        ? maximum
        : Math.max(maximum, participant.record?.ticket || 0),
      0
    );
    if (!Number.isSafeInteger(maximumTicket + 1)) {
      throw identityStoreError(new Error("Identity rotation ticket space is exhausted."));
    }
    const ticket = maximumTicket + 1;
    serialized = serializeIdentityRotationParticipant({
      pid: process.pid,
      processStart,
      token,
      choosing: false,
      ticket
    });
    await replacePrivateIdentityLock(storage, path, serialized);
    await waitForIdentityRotationTurn(
      storage,
      { name, path, serialized, ticket, token },
      deadline,
      signal
    );

    let released = false;
    return {
      async assertOwned() {
        if (released || await readIdentityLockBytes(path) !== serialized) {
          throw identityStoreError(new Error("Identity rotation lock ownership changed."));
        }
      },
      async release() {
        if (released) return;
        released = true;
        await rm(path, { force: true });
      }
    };
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

function serializeIdentityRotationParticipant(participant) {
  return `${JSON.stringify({
    version: 1,
    pid: participant.pid,
    processStart: participant.processStart,
    createdAt: Date.now(),
    token: participant.token,
    choosing: participant.choosing,
    ticket: participant.ticket
  })}\n`;
}

async function waitForIdentityRotationTurn(storage, owner, deadline, signal) {
  let predecessor;
  while (true) {
    await assertIdentityRotationParticipantOwned(owner);
    const participants = await readIdentityRotationParticipants(storage);
    const choosing = participants.some(
      participant => participant.name !== owner.name &&
        (participant.record == null || participant.record.choosing)
    );
    if (!choosing) {
      predecessor = participants
        .filter(participant =>
          participant.name !== owner.name &&
          identityRotationPriorityCompare(participant.record, owner) < 0
        )
        .sort((left, right) => identityRotationPriorityCompare(left.record, right.record))
        .at(-1);
      break;
    }
    await waitForIdentityRotationRetry(deadline, signal);
  }

  if (predecessor == null) return;
  while (true) {
    await assertIdentityRotationParticipantOwned(owner);
    const participant = await readIdentityRotationParticipant(
      predecessor.path,
      predecessor.name,
      predecessor.owner
    );
    if (participant == null) return;
    if (!await isSameLiveProcess(predecessor.owner)) {
      await rm(predecessor.path, { force: true });
      return;
    }
    const record = validateIdentityRotationParticipantRecord(
      participant.record,
      predecessor.owner
    );
    if (record == null) {
      const ageMs = Math.max(0, Date.now() - participant.metadata.mtimeMs);
      if (ageMs >= IDENTITY_ROTATION_LOCK_INCOMPLETE_GRACE_MS) {
        throw corruptIdentityStoreError();
      }
    }
    await waitForIdentityRotationRetry(deadline, signal);
  }
}

async function assertIdentityRotationParticipantOwned(owner) {
  if (await readIdentityLockBytes(owner.path) !== owner.serialized) {
    throw identityStoreError(new Error("Identity rotation lock ownership changed."));
  }
}

function identityRotationPriorityCompare(left, right) {
  if (left.ticket !== right.ticket) return left.ticket - right.ticket;
  return left.token.localeCompare(right.token);
}

async function waitForIdentityRotationRetry(deadline, signal) {
  throwIfIdentityMutationAborted(signal);
  if (Date.now() >= deadline) {
    throw identityStoreError(new Error("Timed out waiting for the identity rotation lock."));
  }
  await identityRotationLockDelay(signal);
}

async function readIdentityRotationParticipants(storage) {
  const prefix = `${storage.keyName}.rotation.`;
  const entries = await readdir(storage.operationDirectoryPath, { withFileTypes: true });
  const participants = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".lock")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw corruptIdentityStoreError();
    const owner = identityRotationParticipantOwner(entry.name, prefix);
    if (owner == null) throw corruptIdentityStoreError();
    const path = join(storage.operationDirectoryPath, entry.name);
    const participant = await readIdentityRotationParticipant(path, entry.name, owner);
    if (participant == null) continue;

    if (!await isSameLiveProcess(owner)) {
      await rm(path, { force: true });
      continue;
    }
    const record = validateIdentityRotationParticipantRecord(participant.record, owner);
    if (record == null) {
      const ageMs = Math.max(0, Date.now() - participant.metadata.mtimeMs);
      if (ageMs >= IDENTITY_ROTATION_LOCK_INCOMPLETE_GRACE_MS) {
        throw corruptIdentityStoreError();
      }
    }
    participants.push({ ...participant, record });
  }
  return participants;
}

async function readIdentityRotationParticipant(path, name, owner) {
  let metadata;
  let serialized;
  try {
    metadata = await lstat(path);
    validateIdentityLockFile(metadata);
    serialized = await readIdentityLockBytes(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "PRIVACYAI_IDENTITY_KEY_CHANGED") return null;
    if (error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT") throw error;
    throw corruptIdentityStoreError(error);
  }

  let record = null;
  try {
    record = JSON.parse(serialized);
  } catch {
    // An owner can be terminated between exclusive creation and its first
    // write. Live incomplete records receive a short grace period.
  }
  return { metadata, name, owner, path, record, serialized };
}

function identityRotationParticipantOwner(name, prefix) {
  const parts = name.slice(prefix.length, -".lock".length).split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return null;
  const pid = Number(parts[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const processStart = parts[1] === "unknown"
    ? null
    : /^\d+$/.test(parts[1]) ? parts[1] : undefined;
  if (processStart === undefined) return null;
  const token = parts[2];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return null;
  }
  return { pid, processStart, token };
}

function validateIdentityRotationParticipantRecord(record, owner) {
  const processStart = record?.processStart == null ? null : String(record.processStart);
  const validTicket = record?.choosing === true
    ? record.ticket == null
    : record?.choosing === false && Number.isSafeInteger(record.ticket) && record.ticket > 0;
  if (
    record?.version !== 1 ||
    record.pid !== owner.pid ||
    processStart !== owner.processStart ||
    record.token !== owner.token ||
    !Number.isFinite(record.createdAt) ||
    !validTicket
  ) {
    return null;
  }
  return { ...record, processStart };
}

async function writePrivateIdentityLock(path, serialized) {
  let handle;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      (constants.O_NOFOLLOW || 0);
    handle = await open(path, flags, 0o600);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.chmod(0o600);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function replacePrivateIdentityLock(storage, path, serialized) {
  const tempPath = await identityTempPath(storage);
  try {
    await writePrivateIdentityLock(tempPath, serialized);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function readIdentityLockBytes(path) {
  let handle;
  try {
    const pathMetadata = await lstat(path);
    validateIdentityLockFile(pathMetadata);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const openedMetadata = await handle.stat();
    validateIdentityLockFile(openedMetadata);
    if (!sameFile(pathMetadata, openedMetadata)) throw changedIdentityStoreError();
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateIdentityLockFile(metadata) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 4 * 1024 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw corruptIdentityStoreError();
  }
}

function identityRotationLockTimeout(value) {
  if (value == null) return IDENTITY_ROTATION_LOCK_WAIT_MS;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > IDENTITY_ROTATION_LOCK_WAIT_MS) {
    throw new TypeError(
      `PrivacyAI identity rotation lock timeout must be between 1 and ${IDENTITY_ROTATION_LOCK_WAIT_MS} milliseconds.`
    );
  }
  return Math.floor(timeout);
}

function identityRotationLockDelay(signal) {
  const spread = IDENTITY_ROTATION_LOCK_RETRY_MAX_MS - IDENTITY_ROTATION_LOCK_RETRY_MIN_MS;
  const delay = IDENTITY_ROTATION_LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (spread + 1));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(identityMutationAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function identityMutationSignal(signal) {
  if (signal == null) return null;
  if (
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("PrivacyAI identity mutation signal must be an AbortSignal.");
  }
  return signal;
}

function throwIfIdentityMutationAborted(signal) {
  if (signal?.aborted) throw identityMutationAbortError();
}

function identityMutationAbortError() {
  const error = new Error("PrivacyAI identity mutation was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function deferIdentityMutationRelease(storage, lock) {
  setImmediate(() => {
    lock.release()
      .catch(() => {})
      .finally(() => storage.directoryHandle.close().catch(() => {}));
  });
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
    const path = join(storage.operationDirectoryPath, entry.name);
    const owner = identityTempOwner(entry.name, prefix);
    if (owner == null) return;
    if (await isSameLiveProcess(owner)) {
      if (owner.processStart != null) return;
      try {
        const metadata = await lstat(path);
        if (Date.now() - metadata.mtimeMs < IDENTITY_TEMP_MAX_UNKNOWN_OWNER_AGE_MS) return;
      } catch {
        return;
      }
    }
    await rm(path, { force: true }).catch(() => {});
  }));
}

async function readIdentityRecord(path) {
  let changedError;
  for (let attempt = 0; attempt < IDENTITY_READ_RETRY_LIMIT; attempt += 1) {
    try {
      return await readIdentityRecordOnce(path);
    } catch (error) {
      if (error?.code !== "PRIVACYAI_IDENTITY_KEY_CHANGED") throw error;
      changedError = error;
    }
  }
  throw identityStoreError(changedError);
}

async function readIdentityRecordOnce(path) {
  let handle;
  let value;
  try {
    const pathMetadata = await lstat(path);
    validateIdentityKeyFile(pathMetadata);
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    handle = await open(path, flags);
    const openedMetadata = await handle.stat();
    validateIdentityKeyFile(openedMetadata);
    if (!sameFile(pathMetadata, openedMetadata)) {
      throw changedIdentityStoreError();
    }
    value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    if (
      error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT" ||
      error?.code === "PRIVACYAI_IDENTITY_KEY_CHANGED"
    ) {
      throw error;
    }
    throw corruptIdentityStoreError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corruptIdentityStoreError();
  }
  return value;
}

function identityTempOwner(name, prefix) {
  const parts = name.slice(prefix.length, -".tmp".length).split(".");
  if (!/^\d+$/.test(parts[0] || "")) return null;
  const pid = Number(parts[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const processStart = /^\d+$/.test(parts[1] || "") ? parts[1] : null;
  return { pid, processStart };
}

function validateIdentityKeyFile(metadata) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 16 * 1024 ||
    (metadata.mode & 0o077) !== 0
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

function changedIdentityStoreError() {
  const error = new Error("PrivacyAI identity key material changed during inspection.");
  error.code = "PRIVACYAI_IDENTITY_KEY_CHANGED";
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

function windowsIdentityStorageUnavailableError() {
  return identityStoreError(new Error(
    "Persistent identity storage on Windows requires handle-relative anti-reparse filesystem operations."
  ));
}
