import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createPrivacyIdentityService,
  privacyIdentityEqual,
  stableIdentitySerialize
} from "../src/node-identity.js";
import { createPrivacyIdentityContract } from "../src/identity-contract.js";
import {
  formatPrivacyPlaceholder,
  parsePrivacyPlaceholder,
  validatePrivacyPlaceholder
} from "../src/placeholder-identity.js";
import { normalizeSessionMap, restoreText } from "../src/session-map.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const SCOPE = { kind: "session", id: "session-alpha" };

test("identity golden vector is stable and NFC-normalized", () => {
  const identity = createPrivacyIdentityService({ key: KEY, scope: SCOPE });
  const protectedValue = identity.protectedValue("cafe\u0301");
  const placeholder = identity.placeholder("[EMAIL_9]", "café", {
    category: "EMAIL",
    domain: "text"
  });

  assert.equal(identity.keyId, "kid1:994b61e5f78054b08fb28f3c3101ba96");
  assert.equal(
    protectedValue.id,
    "pvi1:4c3c71ae7081afae536a793de0e696540ea4d150fdd79c146e036b0c432a3b4d"
  );
  assert.equal(
    placeholder.id,
    "phi1:ecbb0e783762732b0ea17ecfca4e5728b23f00eb6afddfbab8085cb623367aba"
  );
  assert.equal(
    identity.canonicalPlaceholder("café", { category: "EMAIL", domain: "text" }).alias,
    "[PAI1_EMAIL_ECBB0E783762732B0EA17ECF]"
  );
});

test("scope, category, and domain isolation are explicit", () => {
  const root = createPrivacyIdentityService({ key: KEY });
  const sessionA = root.forScope({ kind: "session", id: "a" });
  const sessionB = root.forScope({ kind: "session", id: "b" });
  const value = "owner@example.test";

  assert.notEqual(sessionA.protectedValue(value).id, sessionB.protectedValue(value).id);
  assert.notEqual(
    sessionA.placeholder("[EMAIL_1]", value, { category: "EMAIL", domain: "text" }).id,
    sessionA.placeholder("[PERSON_1]", value, { category: "PERSON", domain: "text" }).id
  );
  assert.notEqual(
    sessionA.placeholder("[EMAIL_1]", value, { category: "EMAIL", domain: "text" }).id,
    sessionA.placeholder("[EMAIL_1]", value, {
      category: "EMAIL",
      domain: "provider-identifier"
    }).id
  );
});

test("visible alias does not define logical placeholder identity", () => {
  const identity = createPrivacyIdentityService({ key: KEY, scope: SCOPE });
  const original = "owner@example.test";
  const first = identity.placeholder("[EMAIL_1]", original, {
    category: "EMAIL",
    domain: "text"
  });
  const second = identity.placeholder("contact1@example.com", original, {
    category: "EMAIL",
    domain: "text"
  });
  assert.equal(first.id, second.id);
  assert.equal(first.protectedValueId, second.protectedValueId);
});

test("canonical alias rewriting is deterministic and restorable", () => {
  const identity = createPrivacyIdentityService({ key: KEY, scope: SCOPE });
  const original = "owner@example.test";
  const first = identity.canonicalizeAliases(
    "Email [EMAIL_1] then contact1@example.com",
    {
      "[EMAIL_1]": original,
      "contact1@example.com": original
    },
    { domain: "text" }
  );
  const second = identity.canonicalizeAliases(
    "Email [EMAIL_99]",
    { "[EMAIL_99]": original },
    { domain: "text" }
  );

  assert.equal(Object.keys(first.sessionMap).length, 1);
  assert.equal(Object.keys(first.sessionMap)[0], Object.keys(second.sessionMap)[0]);
  assert.equal(restoreText(first.sanitizedText, first.sessionMap), `Email ${original} then ${original}`);
});

test("placeholder parser accepts legacy aliases and validates canonical v1", () => {
  assert.deepEqual(parsePrivacyPlaceholder("[EMAIL_7]"), {
    format: "legacy",
    version: 0,
    category: "EMAIL",
    ordinal: 7,
    alias: "[EMAIL_7]"
  });
  const canonical = formatPrivacyPlaceholder({
    category: "email",
    digest: "a".repeat(24)
  });
  assert.equal(canonical, `[PAI1_EMAIL_${"A".repeat(24)}]`);
  assert.equal(validatePrivacyPlaceholder(canonical).version, 1);
  assert.throws(
    () => normalizeSessionMap({ "[PAI2_EMAIL_BAD]": "private@example.test" }),
    error => error?.code === "PRIVACYAI_INVALID_SESSION_MAP"
  );
});

test("stable serialization ignores object insertion order", () => {
  const identity = createPrivacyIdentityService({ key: KEY, scope: SCOPE });
  assert.equal(
    identity.digest("cache:test", { b: 2, a: 1 }),
    identity.digest("cache:test", { a: 1, b: 2 })
  );
  assert.notEqual(
    identity.digest("cache:test", { a: 1 }),
    identity.digest("lineage:test", { a: 1 })
  );
});

test("stable serialization rejects cycles, exotic objects, and accessors", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => stableIdentitySerialize(cyclic), /cyclic/i);
  assert.throws(() => stableIdentitySerialize(new Date(0)), /plain objects/i);
  assert.throws(() => stableIdentitySerialize(new Map()), /plain objects/i);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "privateValue", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    }
  });
  assert.throws(() => stableIdentitySerialize(accessor), /accessor/i);
  assert.equal(getterCalls, 0);
});

test("collision checks fail closed instead of merging different values", () => {
  const contract = createPrivacyIdentityContract({
    keyId: "kid1:collision-test",
    scope: SCOPE,
    deriveDigest(domain, serialized) {
      if (domain === "protected-value") return "0".repeat(64);
      return createHash("sha256").update(domain).update(serialized).digest("hex");
    }
  });
  contract.protectedValue("first");
  assert.throws(
    () => contract.protectedValue("second"),
    error => error?.code === "PRIVACYAI_IDENTITY_COLLISION"
  );
});

test("canonical visible alias collisions fail closed", () => {
  const contract = createPrivacyIdentityContract({
    keyId: "kid1:alias-collision-test",
    scope: SCOPE,
    deriveDigest(domain, serialized) {
      const digest = createHash("sha256").update(domain).update(serialized).digest("hex");
      return domain === "placeholder" ? "a".repeat(24) + digest.slice(24) : digest;
    }
  });
  contract.canonicalPlaceholder("first", { category: "EMAIL", domain: "text" });
  assert.throws(
    () => contract.canonicalPlaceholder("second", { category: "EMAIL", domain: "text" }),
    error => error?.code === "PRIVACYAI_IDENTITY_COLLISION"
  );
});

test("constant-time identity comparison exposes only equality", () => {
  assert.equal(privacyIdentityEqual("pvi1:abc", "pvi1:abc"), true);
  assert.equal(privacyIdentityEqual("pvi1:abc", "pvi1:abd"), false);
  assert.equal(privacyIdentityEqual("short", "longer"), false);
});
