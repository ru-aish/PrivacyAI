import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  createPrivacyIdentityService,
  generatePrivacyIdentityKey,
  privacyIdentityKeyId
} from "@privacy-ai/sdk/identity";

const INSTALLATION_KEY_VERSION = 1;
const INSTALLATION_KEY_BYTES = 32;

export function defaultPrivacyIdentityKeyPath(options = {}) {
  if (options.identityKeyPath) return resolve(options.identityKeyPath);
  if (process.env.PRIVACYAI_IDENTITY_KEY_FILE) {
    return resolve(process.env.PRIVACYAI_IDENTITY_KEY_FILE);
  }
  if (options.identityBaseDir) {
    return join(resolve(options.identityBaseDir), "key-v1.json");
  }
  if (options.baseDir) {
    return join(resolve(options.baseDir), ".privacyai-identity-key-v1.json");
  }
  return join(homedir(), ".local", "share", "privacyai", "identity", "key-v1.json");
}

export async function loadInstallationPrivacyIdentity(options = {}) {
  const path = defaultPrivacyIdentityKeyPath(options);
  return identityFromRecord(await readIdentityRecord(path));
}

export async function openInstallationPrivacyIdentity(options = {}) {
  if (isPrivacyIdentityService(options.identityRoot)) return options.identityRoot;
  if (options.identityKey instanceof Uint8Array) {
    return createPrivacyIdentityService({ key: options.identityKey });
  }

  const path = defaultPrivacyIdentityKeyPath(options);
  await ensurePrivateDirectory(dirname(path));
  try {
    return identityFromRecord(await readIdentityRecord(path));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const key = generatePrivacyIdentityKey();
  const record = installationKeyRecord(key);
  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    await chmod(path, 0o600);
    return createPrivacyIdentityService({ key });
  } catch (error) {
    if (error?.code !== "EEXIST") throw identityStoreError(error);
    return identityFromRecord(await readIdentityRecord(path));
  }
}

export async function rotateInstallationPrivacyIdentityKey(options = {}) {
  const path = defaultPrivacyIdentityKeyPath(options);
  await ensurePrivateDirectory(dirname(path));
  let previousKeyId = null;
  try {
    previousKeyId = (await readIdentityRecord(path)).keyId;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const key = generatePrivacyIdentityKey();
  const record = installationKeyRecord(key);
  const tempPath = path + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw identityStoreError(error);
  }
  return {
    path,
    previousKeyId,
    keyId: record.keyId,
    identityRoot: createPrivacyIdentityService({ key })
  };
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
    if (
      pathMetadata.dev !== openedMetadata.dev ||
      pathMetadata.ino !== openedMetadata.ino
    ) {
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

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
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

function identityStoreError(cause) {
  const error = new Error("PrivacyAI could not persist installation identity key material.", { cause });
  error.code = "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE";
  return error;
}
