import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  PRIVACY_IDENTITY_CONTRACT_VERSION,
  PRIVACY_IDENTITY_SCOPE_KINDS,
  canonicalizeProtectedValue,
  createPrivacyIdentityContract,
  normalizePrivacyIdentityScope,
  stableIdentitySerialize
} from "./identity-contract.js";
import {
  CANONICAL_PRIVACY_PLACEHOLDER_PATTERN_SOURCE,
  PRIVACY_PLACEHOLDER_CONTRACT_VERSION,
  formatPrivacyPlaceholder,
  isCanonicalPrivacyPlaceholder,
  looksLikeMalformedCanonicalPlaceholder,
  normalizePrivacyCategory,
  parsePrivacyPlaceholder,
  privacyCategoryFromAlias,
  validatePrivacyPlaceholder
} from "./placeholder-identity.js";

const MIN_KEY_BYTES = 32;
const DERIVATION_PREFIX = Buffer.from("privacyai\0identity\0v1\0", "utf8");

export function generatePrivacyIdentityKey() {
  return randomBytes(MIN_KEY_BYTES);
}

export function createPrivacyIdentityService(options = {}) {
  const key = normalizeIdentityKey(options.key);
  const keyId = privacyIdentityKeyId(key);
  const scope = options.scope || { kind: "installation", id: keyId };
  return createPrivacyIdentityContract({
    keyId,
    scope,
    compare: privacyIdentityEqual,
    deriveDigest(domain, serialized) {
      return createHmac("sha256", key)
        .update(DERIVATION_PREFIX)
        .update(lengthPrefix(domain))
        .update(lengthPrefix(serialized))
        .digest("hex");
    }
  });
}

export function privacyIdentityKeyId(key) {
  const normalized = normalizeIdentityKey(key);
  const digest = createHmac("sha256", normalized)
    .update(DERIVATION_PREFIX)
    .update("key-id")
    .digest("hex")
    .slice(0, 32);
  return `kid1:${digest}`;
}

export function privacyIdentityEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function normalizeIdentityKey(value) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Privacy identity keys must be Uint8Array values.");
  }
  const key = Buffer.from(value);
  if (key.length < MIN_KEY_BYTES) {
    throw new TypeError(`Privacy identity keys must contain at least ${MIN_KEY_BYTES} bytes.`);
  }
  return key;
}

function lengthPrefix(value) {
  const bytes = Buffer.from(String(value), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export {
  CANONICAL_PRIVACY_PLACEHOLDER_PATTERN_SOURCE,
  PRIVACY_IDENTITY_CONTRACT_VERSION,
  PRIVACY_IDENTITY_SCOPE_KINDS,
  PRIVACY_PLACEHOLDER_CONTRACT_VERSION,
  canonicalizeProtectedValue,
  formatPrivacyPlaceholder,
  isCanonicalPrivacyPlaceholder,
  looksLikeMalformedCanonicalPlaceholder,
  normalizePrivacyCategory,
  normalizePrivacyIdentityScope,
  parsePrivacyPlaceholder,
  privacyCategoryFromAlias,
  stableIdentitySerialize,
  validatePrivacyPlaceholder
};
