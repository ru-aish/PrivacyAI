# Codex 0.152 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PrivacyAI compatible with exact Codex CLI 0.152.1 without widening its fail-closed privacy boundary.

**Architecture:** Extend the existing explicit Codex request validators for the new 0.152.1 fields, preserve required bounded metadata, and remove warehouse-only attempted-tool telemetry before upstream forwarding. Exercise the real launcher and exact stock binary so future Codex drift fails in CI instead of on a user's machine.

**Tech Stack:** Node.js 22, `node:test`, pnpm workspaces, Codex CLI 0.152.1, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-03-codex-0152-compatibility-design.md`

## Global Constraints

- Target exact stable Codex CLI 0.152.1.
- Preserve fail-closed handling for unknown request fields.
- Never forward warehouse-only raw attempted-tool arguments.
- Use only synthetic private test values.
- Do not publish an npm release or support Codex 0.153 alpha.

---

### Task 1: Codex 0.152 request metadata

**Files:**
- Modify: `packages/agent-bridge/src/codex-request-transform.js`
- Test: `packages/agent-bridge/test/codex-provider-gateway.test.js`
- Test: `packages/agent-bridge/test/native-wrapper.test.js`

**Interfaces:**
- Consumes: response-item objects passed through `sanitizeCodexRequestBody()`.
- Produces: strict metadata validation and an outbound body with warehouse-only fields removed.

- [x] **Step 1: Add failing gateway tests**

Add literal 0.152.1 fixtures proving valid `create_time` and aligned
`content_item_kinds` are preserved, warehouse-only fields are absent from the
result body, and malformed timestamps, arrays, alignment, and unknown fields
raise `PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD` or
`PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE`.

- [x] **Step 2: Run the tests and verify the known red failure**

Run:

```bash
node --test --test-name-pattern='Codex 0.152' packages/agent-bridge/test/codex-provider-gateway.test.js
```

Expected: the valid fixture fails on unsupported `create_time` before the
implementation exists.

- [x] **Step 3: Implement bounded validation and telemetry removal**

Update `sanitizeInternalMessageMetadata()` to accept the six exact 0.152.1
keys, validate required fields, delete `cell_id`, `executed_tool_calls`, and
`tool_calls_complete`, and remove an empty metadata wrapper. Pass the response
item into a helper that can verify `content_item_kinds.length === content.length`
for message-like content.

- [x] **Step 4: Add and verify startup-audit regression**

Use a captured, reduced 0.152.1 prompt fixture in the native wrapper/startup
audit test. Verify the failure before production changes and success after them.

- [x] **Step 5: Run focused green tests**

```bash
node --test packages/agent-bridge/test/codex-provider-gateway.test.js packages/agent-bridge/test/native-wrapper.test.js
```

Expected: all focused tests pass.

### Task 2: Remaining 0.152 protocol and stock integration

**Files:**
- Modify: `packages/agent-bridge/src/codex-request-transform.js`
- Modify: `packages/agent-bridge/test/codex-provider-gateway.test.js`
- Modify: `packages/agent-bridge/test/codex-mcp-integration.test.js`
- Modify: `packages/agent-bridge/test/codex-stock-integration.test.js`

**Interfaces:**
- Consumes: exact 0.152.1 `ResponseItem` shapes and normalized MCP namespaces.
- Produces: validated optional encrypted function arguments and namespaced function outputs.

- [x] **Step 1: Add failing request-shape tests**

Add positive and invalid fixtures for `function_call.encrypted_function_args`
and `function_call_output.name`/`namespace`, using literal expected outbound
objects and bounded-value failure cases.

- [x] **Step 2: Verify red failures**

Run the new named tests and confirm the old allowlists reject each new field.

- [x] **Step 3: Add minimal field handling**

Allow optional output name/namespace through existing provider-identifier
validation. Accept encrypted arguments only as a bounded array of non-empty,
bounded strings and never pass them through the local sanitizer.

- [x] **Step 4: Exercise a package-style MCP name**

Change the stock MCP fixture server name to
`npm:@privacy-ai/privacy.test` and assert Codex's normalized namespace,
restored local argument/result, and sanitized upstream requests.

- [x] **Step 5: Run exact 0.152.1 stock tests**

Resolve an exact 0.152.1 binary in the test environment, then run:

```bash
node --test packages/agent-bridge/test/codex-stock-integration.test.js packages/agent-bridge/test/codex-mcp-integration.test.js
```

Expected: command, MCP, hosted Luna tools, and Lark grammar tests pass.

### Task 3: Release assurance and delivery

**Files:**
- Modify: `.github/workflows/live-release-review.yml`
- Modify: `scripts/live-acceptance/live-acceptance.test.mjs`
- Modify: release smoke tests or scripts only if behavior can be exercised without credentials.
- Modify: compatibility documentation if test evidence changes the design.

**Interfaces:**
- Consumes: packed CLI/SDK artifacts and exact Codex 0.152.1.
- Produces: release gates that fail on launcher/schema incompatibility.

- [x] **Step 1: Add failing release-contract assertions**

Require the workflow to pin 0.152.1 and execute a non-network
`codex debug prompt-input` compatibility check through the packaged bridge.

- [x] **Step 2: Verify red, update workflow, and verify green**

```bash
node --test scripts/live-acceptance/live-acceptance.test.mjs
```

- [x] **Step 3: Run full verification**

Run the full workspace suite, deployment assurance, live-review contracts,
`git diff --check`, package dry-runs, and a fresh installed-package launcher
smoke with synthetic data.

- [x] **Step 4: Run Luna human-path review**

Give Luna the built CLI path, exact commands, synthetic secrets, and request
evidence location. Require a concise PASS/FAIL report for startup, shell, MCP,
hosted tools, diagnostics, privacy, and cleanup.

- [ ] **Step 5: Review, commit, push, and open PR**

Request independent code review against `origin/main`, resolve all critical and
important findings, commit the final verified tree, push
`fix/codex-0152-compatibility`, and open a PR against `main` with exact test
evidence.
