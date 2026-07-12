> **Implementation update — July 12, 2026:** The native-hook prototype has been P0-hardened. Claude uses a structured result gateway that discovers new private values; Codex and AGY now default to prompt-only tool isolation where their native APIs cannot guarantee every failure/control-channel result. Credential-only runtime homes, startup-context preflights, native `@file`/slash/shell guards, transactional session maps, and a Codex model-input canary audit are implemented. The exact final network request is still not universally interceptable without a proxy or maintained host patch. See `docs/native-agent-tui-wrapper.md`.

# Agent CLI privacy layer: verified design for Claude Code and Codex

Date: 2026-07-11

## Goal

Extend PrivacyAI beyond SDK calls and browser extensions so an agentic coding CLI can operate normally while sensitive local values remain hidden from the remote model.

The required reversible flow is:

```text
local user/context
    -> sanitize before remote model request
    -> remote model reasons with placeholders
    -> restore placeholders immediately before local tool execution
    -> execute tool with real local values
    -> sanitize tool output before the next remote model request
    -> optionally restore placeholders only for local display
```

Redaction alone is not sufficient. The bridge must preserve a local placeholder-to-original map for the lifetime of an agent thread and apply transformations in both directions.

## Local installations inspected

### Claude Code

- Resolved executable: `/home/coder/.local/share/claude/versions/2.1.206`
- Shell command: `/home/coder/.local/bin/claude`
- Installed version: `2.1.206`
- Packaging: one native executable; source patching is not a maintainable integration path.

### Codex

- Resolved launcher: `/home/coder/.local/lib/node_modules/@openai/codex/bin/codex.js`
- Shell command: `/home/coder/.local/bin/codex`
- Active installed version: `0.143.0`
- Packaging: JavaScript launcher plus a native Rust binary.
- Matching official source inspected from tag `rust-v0.143.0` at commit `c4d748f`.
- A separate npm-global `0.144.1` package exists, but it is not the executable currently selected by the shell.

No global Claude Code or Codex settings were changed during this investigation.

## Verified interception matrix

| Boundary | Claude Code 2.1.206 | Codex 0.143.0 |
|---|---|---|
| Replace initial user prompt with sanitized text | Not through `UserPromptSubmit`; needs wrapper or model transport proxy | Not through `UserPromptSubmit`; needs wrapper or model transport proxy |
| Rewrite built-in tool arguments before execution | Yes: `PreToolUse.updatedInput` | Yes: `PreToolUse.updatedInput` |
| Rewrite MCP arguments before execution | Yes | Yes |
| Replace built-in tool result while preserving structure | Yes: `PostToolUse.updatedToolOutput` | No native arbitrary result replacement in this version |
| Hide built-in tool result as sanitized text | Yes | Yes, using the PostToolUse feedback-replacement fallback |
| Preserve structured MCP output | Yes with `updatedToolOutput` | Use a PrivacyAI MCP gateway, or patch/fork Codex |
| Configure a local model-protocol endpoint | `ANTHROPIC_BASE_URL` works in the installed CLI | Custom `model_providers.<id>.base_url` works |
| Restore final response only for local display | Use a stream/UI wrapper or transport response adapter | Use app-server/JSONL wrapper or transport response adapter |

## End-to-end tests performed

Both CLIs were tested against local protocol mocks. The mocks generated a real tool call without contacting a model provider and captured the next request that the CLI would have sent to the model.

The test placeholder was `[PERSON_1]`; its local value was `RESTORED_LOCAL_VALUE`.

### Claude Code result

1. The mock Anthropic response emitted a Bash call containing `[PERSON_1]`.
2. A real Claude Code `PreToolUse` command hook received the placeholder.
3. The hook returned `updatedInput` with `RESTORED_LOCAL_VALUE`.
4. Bash executed the restored command and produced `RESTORED_LOCAL_VALUE`.
5. A real `PostToolUse` hook received that raw local output.
6. The hook returned `updatedToolOutput` containing `[SANITIZED_TOOL_RESULT]`.
7. The captured second `/v1/messages?beta=true` request contained only `[SANITIZED_TOOL_RESULT]`.

This is a complete reversible privacy boundary for tool calls and results.

### Codex result

1. The local Responses mock emitted an `exec_command` call containing `[PERSON_1]`.
2. Codex exposed it to the hook as canonical tool `Bash` with `{ "command": ... }`.
3. A trusted `PreToolUse` hook returned `updatedInput` containing `RESTORED_LOCAL_VALUE`.
4. Codex executed the restored command successfully.
5. Without a post transformation, the captured second `/v1/responses` request contained the real value. This proves that PreToolUse alone is not a complete privacy boundary.
6. A second run used Codex's supported PostToolUse feedback replacement. The captured `function_call_output` then contained only `[SANITIZED_TOOL_RESULT]`.

The fallback protects shell output, but converts output to text. The installed parser explicitly rejects arbitrary `updatedMCPToolOutput`, so it cannot preserve every structured result the way Claude Code can.

## What was added to the repository

A small prototype package now exists at:

```text
packages/agent-bridge/
```

It provides:

- recursive restoration of placeholders in JSON tool arguments;
- recursive replacement of known originals in JSON tool output;
- one PreToolUse response envelope compatible with both CLIs;
- Claude's native structured `updatedToolOutput` response;
- Codex's sanitized text feedback fallback;
- fail-closed behavior for unresolved PrivacyAI placeholders;
- a per-session local vault with hashed filenames and `0600` files;
- a command hook executable;
- seven passing unit tests.

This is a bridge prototype, not yet the complete product boundary.

## Recommended production architecture

### 1. `privacyai-agentd`: local session vault and transformation service

Run one local daemon for all supported agents. It should own:

- the stable `placeholder -> original` map for each agent thread;
- exact known-value replacement;
- local detection of new sensitive values in tool output;
- placeholder allocation and collision avoidance;
- audit metadata that records categories/counts but never original values;
- thread-to-session association for Claude Code, Codex, MCP servers, and model-protocol connections.

The existing SDK's `sanitizedText`, `sessionMap`, and `restore()` are the correct starting primitives. The missing component is a durable multi-turn session abstraction around them.

For production, vault data should be encrypted at rest or stored through the OS keyring. The prototype only uses private file permissions.

### 2. Local model transport proxy: the deepest universal boundary

Hooks do not replace the initial user prompt. A local protocol proxy is therefore required for fluent interactive use.

```text
Claude Code -> PrivacyAI Anthropic proxy -> existing Anthropic/gateway endpoint
Codex       -> PrivacyAI Responses proxy -> OpenAI/custom provider endpoint
```

Outbound responsibilities:

- sanitize all user messages;
- sanitize tool results again as defense in depth;
- sanitize assistant history that was locally restored for display;
- sanitize system/project context when policy says it may contain private data;
- preserve streaming, caching, tool schemas, usage fields, and provider-specific headers.

Inbound responsibilities:

- leave tool-call arguments sanitized so PreToolUse performs the last-moment restore;
- optionally restore ordinary assistant text only on the local display stream;
- never restore reasoning or tool-call data that will be forwarded back upstream without another outbound sanitization pass.

This proxy is also the best integration point for closed-source tools that expose a custom API base URL.

### 3. Native lifecycle hooks for built-in local tools

Use hooks as the execution safety boundary, even when a model proxy is present.

#### Claude Code

- `PreToolUse`: restore every string value recursively inside `tool_input`.
- Deny execution when placeholders remain unresolved.
- `PostToolUse`: run local output sanitization and return a shape-compatible `updatedToolOutput`.
- Match all tools, not only Bash. This includes Read, Write, Edit, search tools, and MCP tools.

#### Codex

- `PreToolUse`: same restore and fail-closed logic.
- `PostToolUse` interim: replace sensitive output with sanitized feedback text.
- Long term: add native structured output replacement to a maintained Codex fork or upstream contribution.

The required Codex patch is localized: carry an optional updated output from the PostToolUse parser/outcome into the tool registry and substitute it before the model-visible `FunctionToolOutput` is constructed.

### 4. PrivacyAI MCP gateway

External MCP tools should be routed through one local proxy:

```text
agent CLI -> PrivacyAI MCP gateway -> original MCP server
```

The gateway should:

- restore placeholders in `tools/call` arguments;
- call the real local or remote MCP server;
- sanitize text, structured content, resources, and error payloads in the response;
- maintain the same session map as the model proxy and CLI hooks.

This solves Codex's structured PostToolUse limitation for MCP tools without requiring a Codex fork. It also creates a common integration path for other agent products.

### 5. Agent launch and UI adapters

Provide commands such as:

```text
privacyai agent claude
privacyai agent codex
```

The launcher should generate isolated settings, set the local base URL, point hooks at `privacyai-agentd`, and associate the CLI's thread id with a PrivacyAI session.

For noninteractive modes, parse Claude stream JSON and Codex JSONL/app-server events and restore final text before printing it. For interactive TUIs, prefer Codex app-server and a PrivacyAI-controlled UI; terminal-level ANSI rewriting is fragile.

## Security invariants

1. A real mapped value must never appear in an outbound model request.
2. A tool must never execute with an unresolved PrivacyAI placeholder.
3. A tool result must be sanitized before it becomes conversation history.
4. The session map must never be placed in prompts, hook output, debug logs, or provider headers.
5. Hook and proxy failures must fail closed when sensitive data may cross the boundary.
6. Transformations must be recursive and preserve tool schema shape whenever the CLI supports it.
7. Exact known-value replacement happens before heuristic detection, ensuring previously mapped values remain stable across turns.
8. New values discovered in tool output must be merged atomically into the same thread's map.

## Main remaining engineering work

### Highest priority

- Add a local-only sanitizer path that does not require `AiSanitizer.provider.chat()` for every tool result.
- Build `privacyai-agentd` and move the prototype map file into a real per-thread vault.
- Build Anthropic Messages and OpenAI Responses streaming proxies.
- Connect Claude and Codex hook commands to the daemon.
- Build the MCP gateway.

### Important after the boundary works

- Restore assistant text for local display without contaminating upstream history.
- Add session recovery across CLI restarts.
- Add strict log redaction and integration tests containing canary secrets.
- Add policy controls by tool, path, recipient domain, and data category.
- Decide whether to maintain a Codex patch or contribute native structured PostToolUse output replacement upstream.

## Recommended next implementation slice

Build the local daemon and Anthropic proxy first, then integrate the verified Claude hooks. Claude Code already supports the full structured tool lifecycle, so it provides the fastest path to a complete, fluent end-to-end product. Reuse the same daemon and protocol abstractions for Codex, add the MCP gateway, and only then decide whether the Codex source patch is necessary for built-in structured tools.
