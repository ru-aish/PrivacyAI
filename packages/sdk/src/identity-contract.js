import {
  formatPrivacyPlaceholder,
  normalizePrivacyCategory,
  parsePrivacyPlaceholder,
  privacyCategoryFromAlias
} from "./placeholder-identity.js";

export const PRIVACY_IDENTITY_CONTRACT_VERSION = 1;
export const PRIVACY_IDENTITY_SCOPE_KINDS = Object.freeze([
  "global",
  "installation",
  "session",
  "request",
  "document",
  "policy"
]);

const SCOPE_KIND_SET = new Set(PRIVACY_IDENTITY_SCOPE_KINDS);
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function normalizePrivacyIdentityScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Privacy identity scope must be an object.");
  }
  const kind = String(value.kind || "").trim().toLocaleLowerCase("en-US");
  const id = String(value.id || "").normalize("NFC");
  if (!SCOPE_KIND_SET.has(kind)) {
    throw new TypeError(`Unsupported privacy identity scope: ${value.kind}`);
  }
  if (!id || id.length > 1024 || /[\0\r\n]/.test(id)) {
    throw new TypeError("Privacy identity scope id must be a non-empty opaque string.");
  }
  return Object.freeze({ kind, id });
}

export function canonicalizeProtectedValue(value, options = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Protected identity values must be non-empty strings.");
  }
  const normalization = String(options.normalization || "nfc").toLocaleLowerCase("en-US");
  if (normalization === "exact") return value;
  if (normalization === "nfc") return value.normalize("NFC");
  if (normalization === "nfkc") return value.normalize("NFKC");
  throw new TypeError(`Unsupported protected-value canonicalization: ${normalization}`);
}

export function stableIdentitySerialize(value) {
  return serialize(value);
}

export function createPrivacyIdentityContract(options = {}) {
  if (typeof options.deriveDigest !== "function") {
    throw new TypeError("Privacy identity contracts require a keyed digest derivation function.");
  }
  const keyId = requiredOpaqueId(options.keyId, "identity key id");
  const scope = normalizePrivacyIdentityScope(options.scope);
  const observed = options.observed instanceof Map ? options.observed : new Map();

  const contract = {
    version: PRIVACY_IDENTITY_CONTRACT_VERSION,
    keyId,
    scope,

    forScope(nextScope) {
      return createPrivacyIdentityContract({
        ...options,
        keyId,
        scope: nextScope,
        observed
      });
    },

    digest(domain, value) {
      return derive(normalizeIdentityDomain(domain), value);
    },

    reference(domain, value) {
      return `hmac-sha256:${keyId}:${contract.digest(`reference:${domain}`, value)}`;
    },

    protectedValue(value, identityOptions = {}) {
      const normalization = String(identityOptions.normalization || "nfc").toLocaleLowerCase("en-US");
      const canonical = canonicalizeProtectedValue(value, { normalization });
      const material = {
        version: PRIVACY_IDENTITY_CONTRACT_VERSION,
        scope,
        normalization,
        value: canonical
      };
      const digest = derive("protected-value", material);
      const id = `pvi1:${digest}`;
      rememberIdentity(id, derive("collision-check:protected-value", material), observed);
      return Object.freeze({
        version: PRIVACY_IDENTITY_CONTRACT_VERSION,
        id,
        keyId,
        scope,
        normalization
      });
    },

    placeholder(alias, value, identityOptions = {}) {
      if (typeof alias !== "string" || alias.length === 0 || /[\0\r\n]/.test(alias)) {
        throw new TypeError("Placeholder aliases must be non-empty strings.");
      }
      const category = normalizePrivacyCategory(
        identityOptions.category || privacyCategoryFromAlias(alias)
      );
      const domain = normalizeIdentityDomain(identityOptions.domain || "text");
      const protectedValue = contract.protectedValue(value, identityOptions);
      const material = {
        version: PRIVACY_IDENTITY_CONTRACT_VERSION,
        scope,
        domain,
        category,
        protectedValueId: protectedValue.id
      };
      const digest = derive("placeholder", material);
      const id = `phi1:${digest}`;
      rememberIdentity(id, derive("collision-check:placeholder", material), observed);
      return Object.freeze({
        version: PRIVACY_IDENTITY_CONTRACT_VERSION,
        id,
        alias,
        category,
        domain,
        keyId,
        scope,
        protectedValueId: protectedValue.id
      });
    },

    canonicalPlaceholder(value, identityOptions = {}) {
      const category = normalizePrivacyCategory(identityOptions.category);
      const protectedValue = contract.protectedValue(value, identityOptions);
      const material = {
        version: PRIVACY_IDENTITY_CONTRACT_VERSION,
        scope,
        domain: normalizeIdentityDomain(identityOptions.domain || "text"),
        category,
        protectedValueId: protectedValue.id
      };
      const digest = derive("placeholder", material);
      const alias = formatPrivacyPlaceholder({ category, digest: digest.slice(0, 24) });
      rememberIdentity("canonical-alias:" + alias, digest, observed);
      return contract.placeholder(alias, value, { ...identityOptions, category });
    },

    describeSessionMap(sessionMap = {}, identityOptions = {}) {
      if (!sessionMap || typeof sessionMap !== "object" || Array.isArray(sessionMap)) return {};
      const output = {};
      for (const [alias, original] of Object.entries(sessionMap)) {
        if (typeof alias !== "string" || typeof original !== "string" || !alias || !original) continue;
        const domain = typeof identityOptions.domainForAlias === "function"
          ? identityOptions.domainForAlias(alias, original)
          : identityOptions.domain || "text";
        const requestedCategory = typeof identityOptions.categoryForAlias === "function"
          ? identityOptions.categoryForAlias(alias, original)
          : null;
        const category = requestedCategory || privacyCategoryFromAlias(alias);
        output[alias] = contract.placeholder(alias, original, { domain, category });
      }
      return output;
    },

    canonicalizeAliases(sanitizedText, sessionMap = {}, identityOptions = {}) {
      if (typeof sanitizedText !== "string") {
        throw new TypeError("Sanitized text must be a string.");
      }
      const replacements = [];
      const canonicalMap = {};
      const entries = Object.entries(sessionMap || {}).filter(([alias, original]) =>
        typeof alias === "string" &&
        typeof original === "string" &&
        alias.length > 0 &&
        original.length > 0
      );
      const explicitCategories = new Map();
      for (const [alias, original] of entries) {
        const parsed = parsePrivacyPlaceholder(alias);
        if (!parsed) continue;
        let categories = explicitCategories.get(original);
        if (!categories) {
          categories = new Set();
          explicitCategories.set(original, categories);
        }
        categories.add(parsed.category);
      }
      for (const [alias, original] of entries) {
        const requestedCategory = typeof identityOptions.categoryForAlias === "function"
          ? identityOptions.categoryForAlias(alias, original)
          : null;
        const category = requestedCategory || resolvedCanonicalCategory(
          alias,
          original,
          explicitCategories
        );
        const domain = identityOptions.domain || "text";
        const canonical = contract.canonicalPlaceholder(original, { category, domain });
        const existing = canonicalMap[canonical.alias];
        if (existing !== undefined && existing !== original) throw identityCollisionError();
        canonicalMap[canonical.alias] = original;
        replacements.push([alias, canonical.alias]);
      }
      replacements.sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
      let text = sanitizedText;
      for (const [source, target] of replacements) {
        if (source !== target) text = text.split(source).join(target);
      }
      return {
        sanitizedText: text,
        sessionMap: canonicalMap,
        identityMap: contract.describeSessionMap(canonicalMap, {
          domain: identityOptions.domain || "text"
        })
      };
    },

    equal(left, right) {
      if (typeof options.compare === "function") return options.compare(left, right);
      return left === right;
    }
  };

  return Object.freeze(contract);

  function derive(domain, value) {
    const digest = String(options.deriveDigest(domain, stableIdentitySerialize(value)))
      .toLocaleLowerCase("en-US");
    if (!HEX_DIGEST_PATTERN.test(digest)) {
      throw new TypeError("Privacy identity digest derivation must return 64 hexadecimal characters.");
    }
    return digest;
  }
}

function serialize(value, ancestors = new Set()) {
  if (value === null) return "n";
  if (value === undefined) return "u";
  if (typeof value === "string") return "s" + byteLength(value) + ":" + value;
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Identity serialization rejects non-finite numbers.");
    return "d" + (Object.is(value, -0) ? "-0" : String(value));
  }
  if (typeof value === "bigint") return "i" + value.toString(10);
  if (Array.isArray(value)) {
    return serializeContainer(value, ancestors, () =>
      "a" + value.length + ":" + value.map(item => serialize(item, ancestors)).join("")
    );
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Identity serialization accepts only plain objects and arrays.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Identity serialization rejects symbol properties.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const enumerableKeys = Object.keys(descriptors)
      .filter(key => descriptors[key].enumerable)
      .sort();
    for (const key of enumerableKeys) {
      if (!("value" in descriptors[key])) {
        throw new TypeError("Identity serialization rejects accessor properties.");
      }
    }
    const keys = enumerableKeys.filter(key => descriptors[key].value !== undefined);
    return serializeContainer(value, ancestors, () =>
      "o" + keys.length + ":" + keys
        .map(key => serialize(key, ancestors) + serialize(descriptors[key].value, ancestors))
        .join("")
    );
  }
  throw new TypeError("Unsupported identity serialization type: " + typeof value);
}

function serializeContainer(value, ancestors, serializeValue) {
  if (ancestors.has(value)) {
    throw new TypeError("Identity serialization rejects cyclic values.");
  }
  ancestors.add(value);
  try {
    return serializeValue();
  } finally {
    ancestors.delete(value);
  }
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function normalizeIdentityDomain(value) {
  const domain = String(value || "").normalize("NFC");
  if (!domain || domain.length > 256 || /[\0\r\n]/.test(domain)) {
    throw new TypeError("Privacy identity domains must be non-empty opaque strings.");
  }
  return domain;
}

function rememberIdentity(id, check, observed) {
  const previous = observed.get(id);
  if (previous && previous !== check) throw identityCollisionError();
  observed.set(id, check);
}

function identityCollisionError() {
  const error = new Error(
    "PrivacyAI detected an identity collision and stopped rather than merging protected values."
  );
  error.code = "PRIVACYAI_IDENTITY_COLLISION";
  return error;
}

function resolvedCanonicalCategory(alias, original, explicitCategories) {
  const parsed = parsePrivacyPlaceholder(alias);
  if (parsed) return parsed.category;
  const categories = explicitCategories.get(original);
  if (categories?.size === 1) return categories.values().next().value;
  return privacyCategoryFromAlias(alias);
}

function requiredOpaqueId(value, label) {
  const normalized = String(value || "");
  if (!/^[A-Za-z0-9:._-]{8,256}$/.test(normalized)) {
    throw new TypeError(`${label} must be an opaque identifier.`);
  }
  return normalized;
}
