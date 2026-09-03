# Codex 0.152 Compatibility Design

## Goal

Make PrivacyAI's Codex gateway and native launcher compatible with the current
stable Codex CLI 0.152.1 while preserving its fail-closed privacy boundary.

## Compatibility baseline

- Target Codex CLI: exact stable version 0.152.1.
- Preserve compatibility with the existing Codex request shapes covered by the
  PrivacyAI 0.4.1 suite.
- Treat OpenAI's 0.152.1 Rust protocol types and an actual
  `codex debug prompt-input` capture as the compatibility contract.
- Do not generally permit unknown fields. Future protocol drift must continue to
  fail closed and produce a safe public error.

## Confirmed incompatibilities

Codex 0.152.1 includes these fields in
`internal_chat_message_metadata_passthrough`:

- `turn_id`
- `create_time`
- `content_item_kinds`
- `cell_id`
- `executed_tool_calls`
- `tool_calls_complete`

PrivacyAI 0.4.1 only permits `turn_id`. A normal configured Codex launch fails
on `create_time`; if that field is removed, it next fails on
`content_item_kinds`. Existing stock-Codex tests use a minimal temporary Codex
home, call the gateway directly, and do not cover the native launcher's exact
startup-prompt verification.

Codex 0.152 also permits package-style MCP server names containing `:`, `@`,
`/`, and `.`. Codex converts these to model-safe callable namespaces, but the
PrivacyAI integration must prove those normalized namespaces, calls, arguments,
and outputs still pass through the privacy gateway correctly.

The live release-review workflow remains pinned to Codex 0.144.5 and therefore
does not enforce the supported 0.152.1 baseline.

PrivacyAI's Linux Codex resolver also assumes the optional native platform
package is nested below `@openai/codex`. npm may instead hoist that package as
a sibling. In that ordinary layout PrivacyAI skips the requested healthy Codex
binary and can silently launch an older binary later on `PATH`. The resolver
must validate both layouts against the launcher version and native package
marker before selecting the executable.

## Protocol handling

### Required message metadata

PrivacyAI will preserve these fields after strict validation:

- `turn_id`: a non-empty bounded protocol token, using the existing validator.
- `create_time`: a finite, nonnegative JSON number no greater than the maximum
  representable JavaScript timestamp in fractional Unix seconds.
- `content_item_kinds`: a bounded array of bounded, non-empty classification
  tokens. Each token may use ASCII letters, digits, `_`, `-`, `.`, `:`, `@`,
  and `/`. For message items the array length must equal the content-item count,
  because Codex defines the values as aligned classifications.

The validator will accept future classification token values that satisfy the
structural contract. It will not require a fixed enumeration, because Codex
models `ContentItemKind` as a forward-compatible string newtype.

### Warehouse-only executed-tool metadata

`cell_id`, `executed_tool_calls`, and `tool_calls_complete` are host-generated,
warehouse-only attempted-tool telemetry. `executed_tool_calls.arguments` can
contain restored local values. PrivacyAI will not forward these three fields to
the upstream provider. It will remove them from the cloned outbound request and
delete an empty metadata object afterward. This avoids creating a second,
unsanitized path for private tool arguments while allowing Codex's local history
to retain its own metadata.

Unknown internal metadata fields remain blocked.

### Other 0.152 response-item fields

The audit will add direct compatibility fixtures for protocol fields present in
the 0.152.1 `ResponseItem` contract but absent from PrivacyAI's explicit
allowlists:

- `function_call.encrypted_function_args`
- `function_call_output.name`
- `function_call_output.namespace`

Opaque encrypted arguments will be accepted only as a bounded array of bounded,
non-empty strings. Optional output name and namespace values will use the same
provider-identifier validation already used for calls. Tests must demonstrate a
real Codex-produced shape or the fields will remain fail-closed; this prevents
speculative widening of the protocol.

Codex 0.152's `input_image.detail` value `original` is part of the supported
image path and will be preserved after the image is sanitized. `input_audio`
will remain explicitly fail-closed with `PRIVACYAI_CODEX_UNSUPPORTED_MEDIA` in
both messages and tool output: PrivacyAI does not yet have a local audio
sanitizer, so forwarding it would bypass the privacy boundary.

## Feature and argument policy

PrivacyAI will keep provider-changing, remote, WebSocket, compression, and
browser/computer execution paths disabled in gateway mode unless the gateway
explicitly mediates them. Tests will cover Codex 0.152's stable
`browser_use_external` and `browser_use_full_cdp_access` flags and prove they
cannot re-enable an unmediated browser path when `browser_use` is disabled.

No changes are planned to PrivacyAI's strict-mode restrictions, hosted web
search policy, hosted image-generation policy, or user-facing privacy mode
selection beyond compatibility tests.

## Test design

Development follows red-green TDD.

### Unit and gateway regressions

- A realistic 0.152.1 message accepts and preserves valid `create_time` and
  aligned `content_item_kinds`.
- Invalid timestamps, malformed classification arrays, excessive values,
  misaligned arrays, and unknown metadata fields fail closed.
- Warehouse-only executed-tool metadata is removed, including private raw tool
  arguments, while required metadata remains.
- An object containing only warehouse metadata loses the now-empty wrapper.
- Any newly supported response-item fields receive positive, invalid-shape, and
  privacy-leak tests.

### Native launcher and exact prompt verification

- Capture a real 0.152.1-shaped startup prompt through the launcher audit path.
- Prove the startup verification seed accepts the complete metadata shape.
- Exercise the actual PrivacyAI launcher rather than only calling
  `buildCodexProviderArgs` and `startCodexProviderGateway` directly.
- Assert the original failure code before the fix and successful launch after
  the fix.

### Stock Codex integration

- Run tests against exact Codex 0.152.1, not whichever binary happens to be on
  `PATH`.
- Prove both nested and npm-hoisted native platform-package layouts resolve to
  the matching binary without falling back to an older installation.
- Keep command execution, stdio MCP argument restoration/result sanitization,
  hosted Luna web/image tool declarations and events, and custom Lark grammar
  coverage.
- Add an MCP server whose package-style name is normalized by Codex and prove
  the resulting namespace, invocation, restoration, and sanitized provider
  request are correct.

### Release and human-path verification

- Update live-release-review's Codex pin from 0.144.5 to 0.152.1.
- Use the authenticated packed-release workflow to perform exact startup prompt
  verification; the credential-free global-install smoke remains responsible
  for package identity and public CLI availability.
- Run `privacyai doctor`, `privacyai state preflight`, the native Codex exec
  path, shell execution, MCP, custom grammar, hosted tools, and cleanup checks.
- Use GPT-5.6 Luna as an independent user-like reviewer. Luna will exercise the
  installed package through the public CLI, inspect only sanitized request
  evidence, and report deviations; parent-level tests remain authoritative.
- Use synthetic private values only. No real user secret may appear in test
  prompts, fixtures, logs, or PR text.

## Delivery

- Implement on `fix/codex-0152-compatibility` from `origin/main`.
- Keep changes focused on the Codex bridge, its tests, release acceptance, and
  compatibility documentation.
- Run focused tests, full workspace tests, package/install smoke tests, and
  fresh live user-path verification before committing the final implementation.
- Request an independent code review, fix all critical or important findings,
  push the branch, and open a PR against `main` with commands and evidence in
  the description.

## Non-goals

- Publishing a new npm release.
- Supporting Codex alpha 0.153 builds.
- Permissive forwarding of unknown Codex fields.
- Refactoring unrelated gateway or SDK code.
- Enabling new browser, computer, remote, or WebSocket transports.
- Forwarding Codex audio before PrivacyAI has a local audio sanitizer.
