# Deterministic Privacy Identity Contract

PrivacyAI owns protected-value and placeholder identity in infrastructure. Codex,
Antigravity, native hooks, image/OCR handling, and individual sanitizers may
classify values or request provider-safe aliases, but they do not define logical
identity independently.

## Contract

Version 1 has two logical identifiers:

- `pvi1:<64 lowercase hex>` identifies a protected value inside an explicit
  scope.
- `phi1:<64 lowercase hex>` identifies the presentation of that protected value
  for one category and identity domain.

Both identifiers are derived with HMAC-SHA-256 from an installation-owned random
32-byte key. Stable, length-prefixed serialization and named derivation domains
prevent cache, lineage, provider-identifier, vault-path, and placeholder hashes
from sharing digest semantics. Serialization accepts primitives, arrays, and
plain data objects; cycles, accessors, symbols, and exotic objects fail closed.

The identifier is metadata. It is not encryption and it is never a substitute
for the exact local restoration map.

## Inputs

Protected-value identity includes:

1. contract version;
2. scope kind and opaque scope id;
3. canonicalization mode;
4. canonicalized protected text.

Placeholder identity additionally includes:

1. placeholder domain;
2. normalized category;
3. protected-value identifier.

The visible alias is deliberately excluded from logical placeholder identity.
`[EMAIL_1]`, a historical human-looking dummy, and the canonical v1 alias can
therefore describe the same logical placeholder without changing restoration.

The default canonicalization is Unicode NFC and remains case-sensitive. `exact`
and NFKC modes are explicit opt-ins. Restoration always retains the exact
original string in the local session map.

## Scope rules

| Scope | Intended use | Restart stability |
| --- | --- | --- |
| installation | installation-wide infrastructure references | yes, while the key persists |
| session | Codex/AGY/native multi-turn lineage | yes |
| request | isolated one-shot work | only when the caller persists the request id |
| document | startup files and image/OCR-derived document work | yes for the same opaque document id |
| policy | policy-bound startup/render verification | yes |
| global | explicit application-owned global semantics only | yes, but discouraged |

Repeated detections of the same value in one session share protected-value
identity. Different sessions intentionally do not. Forked provider threads keep
their inherited restoration aliases but derive new identities once the runtime
establishes a distinct child session scope.

Identity is not stable across installations because each installation owns a
different random key.

## Placeholder formats

Canonical v1 aliases use:

```text
[PAI1_<CATEGORY>_<24-64 UPPERCASE HEX>]
```

The parser accepts historical `[CATEGORY_N]` aliases for restoration and
migration. Malformed strings that claim the `PAI` namespace are rejected rather
than silently treated as arbitrary aliases. Existing human-readable dummies
remain valid legacy aliases.

Runtime sanitization canonicalizes newly discovered aliases only when an
identity service is supplied. Public map and restoration shapes remain
`placeholder -> exact original`.

## Collision behavior

Full 256-bit logical identifiers are retained internally. The canonical visible
alias uses a 96-bit prefix. PrivacyAI tracks both full identifiers and visible
aliases; either kind of collision with a different collision-check digest fails
closed with `PRIVACYAI_IDENTITY_COLLISION`. Provider-safe aliases probe longer
digest prefixes before failing. PrivacyAI never resolves a collision by merging
two originals.

## Key ownership and rotation

The agent runtime creates one random key at
`~/.local/share/privacyai/identity/key-v1.json` by default. The directory is
mode `0700` and the file is mode `0600`. Test and embedded runtimes may supply a
dedicated identity directory or an in-memory key.

Losing the key starts a new identity epoch: old logical ids and keyed cache
references cannot be reproduced. Local vault files still contain the exact
restoration maps under their existing filesystem protections; the identity key
does not encrypt them. A mode-`0600` stable locator contains only the keyed vault
filename, never the session id or restoration values, so a rotated runtime can
load the prior vault and migrate it to the new keyed path on the next save.
Rotation intentionally invalidates keyed cache and lineage identity while
preserving restoration data. Cross-process rotations are serialized by private,
descriptor-relative participant records with bounded and abort-aware waiting,
process-start identity on Linux, and dead-owner cleanup. Cancellation before
publication removes only the caller's participant; once publication begins, the
operation completes rather than reporting an ambiguous cancelled result. A
successful rotation returns only while its new epoch is still installed, and the
reported `previousKeyId` values
therefore form one total predecessor chain. Retaining old ids across a rotation
requires retaining the old key outside PrivacyAI; automatic key backup is not
provided.

Persistent installation-key storage is supported on Linux and macOS. On Windows,
load, creation, and rotation fail before directory creation or key generation:
Node does not currently expose the handle-relative anti-reparse write and rename
operations required to prevent a concurrent junction replacement from
redirecting key bytes. Embedded callers may supply an in-memory `identityKey` or
`identityRoot`, but PrivacyAI does not claim persistent Windows identity storage.

## Privacy and threat considerations

- Raw protected content never appears in placeholders or identity metadata.
- Low-entropy values are protected from practical offline guessing by keyed
  derivation rather than plain hashes.
- Key ids are one-way HMAC-derived labels, not key material.
- Errors and logs expose contract/category/scope labels only, never key bytes or
  protected values.
- Constant-time comparison is used for secret-derived identifier equality where
  the runtime validates persisted key metadata.
- Determinism creates correlation inside the chosen scope. Callers should use
  the narrowest scope matching product semantics.
- Filesystem permissions protect the local key and restoration vault; this
  contract does not claim hardware-backed storage, encryption at rest, or
  resistance to a fully compromised local account.

## Compatibility

Legacy placeholders and session maps continue to restore exactly. Legacy cache
keys remain readable only through existing fallback paths; new runtime-owned
cache references are domain-separated and keyed. Image/OCR detections share the
caller-provided document or session identity while masking and verification
behavior remains unchanged.
