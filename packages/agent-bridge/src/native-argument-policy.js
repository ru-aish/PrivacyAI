import {
  CODEX_GATEWAY_DISABLED_FEATURES,
  isProtectedCodexConfigOverride
} from "./codex-provider-config.js";

export function validateNativeArguments(flavor, args, options = {}) {
  if (!Array.isArray(args)) throw new TypeError("Agent arguments must be an array.");
  if (flavor === "claude") return validateClaudeArguments(args);
  if (flavor === "codex") {
    const mode = options.codexMode || "gateway";
    return mode === "strict"
      ? validateStrictCodexArguments(args)
      : validateGatewayCodexArguments(args);
  }
  throw new TypeError(`Unsupported native agent: ${flavor}`);
}

export function validateNativeEnvironment(flavor, env = process.env) {
  if (flavor !== "claude") return;
  for (const name of ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE"]) {
    if (isTruthyEnvironmentValue(env?.[name])) {
      throw new Error(`PrivacyAI cannot launch Claude while ${name} disables privacy hooks.`);
    }
  }
}

function validateClaudeArguments(args) {
  const isolatedFlags = new Set([
    "--add-dir",
    "--agent",
    "--agents",
    "--allow-dangerously-skip-permissions",
    "--allowedTools",
    "--allowed-tools",
    "--append-subagent-system-prompt",
    "--append-system-prompt",
    "--append-system-prompt-file",
    "--background",
    "--bg",
    "--channels",
    "--chrome",
    "--cloud",
    "--continue",
    "--dangerously-load-development-channels",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--disallowedTools",
    "--disallowed-tools",
    "--exec",
    "--fork-session",
    "--from-pr",
    "--ide",
    "--include-hook-events",
    "--include-partial-messages",
    "--input-format",
    "--json-schema",
    "--mcp-config",
    "--output-format",
    "--plugin-dir",
    "--plugin-url",
    "--print",
    "--remote",
    "--remote-control",
    "--replay-user-messages",
    "--resume",
    "--session-id",
    "--setting-sources",
    "--settings",
    "--strict-mcp-config",
    "--system-prompt",
    "--system-prompt-file",
    "--teleport",
    "--tools",
    "--worktree",
    "-c",
    "-p",
    "-r",
    "-w"
  ]);

  for (const rawArg of args) {
    const arg = String(rawArg);
    if (arg === "--") break;
    if (arg === "--bare" || arg === "--safe-mode") {
      throw new Error(`PrivacyAI cannot launch Claude with ${arg} because it disables privacy hooks.`);
    }
    if (isCompactShortOption(arg)) {
      throw new Error(
        `PrivacyAI rejects combined or attached Claude short options (${arg}) while isolated startup context is active. ` +
        "Pass each short option and its value as separate arguments."
      );
    }
    const flag = arg.split("=", 1)[0];
    if (isolatedFlags.has(flag)) {
      throw new Error(
        `PrivacyAI reserves Claude ${flag} while isolated startup context and privacy hooks are active.`
      );
    }
  }
}

function validateGatewayCodexArguments(args) {
  const blockedFlags = new Set([
    "--remote",
    "--remote-auth-token-env",
    "--oss",
    "--local-provider",
    "-p",
    "--profile"
  ]);
  const blockedCommands = new Set([
    "app-server",
    "mcp-server",
    "remote-control",
    "cloud",
    "exec-server"
  ]);
  const valueFlags = new Set([
    "--ask-for-approval",
    "--cd",
    "--disable",
    "--enable",
    "--model",
    "--sandbox",
    "--image",
    "-i",
    "-C",
    "-a",
    "-m",
    "-s",
    "-c",
    "--config"
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    const next = String(args[index + 1] || "");
    if (arg === "--") break;
    if (isCompactShortOption(arg)) {
      throw new Error(
        `PrivacyAI rejects combined or attached Codex short options (${arg}) because they cannot be audited safely. ` +
        "Pass each short option and its value as separate arguments."
      );
    }
    if (blockedCommands.has(arg)) {
      throw new Error(`PrivacyAI cannot launch Codex ${arg} because it bypasses the protected provider session.`);
    }
    const flag = arg.split("=", 1)[0];
    if (blockedFlags.has(flag)) {
      throw new Error(
        `PrivacyAI reserves Codex ${flag} because that route is not protected by the local provider gateway.`
      );
    }
    if (arg === "--enable" && CODEX_GATEWAY_DISABLED_FEATURES.includes(next)) {
      throw new Error(`PrivacyAI cannot enable Codex feature ${next} because it bypasses local restoration.`);
    }
    if (arg.startsWith("--enable=")) {
      const feature = arg.slice("--enable=".length);
      if (CODEX_GATEWAY_DISABLED_FEATURES.includes(feature)) {
        throw new Error(`PrivacyAI cannot enable Codex feature ${feature} because it bypasses local restoration.`);
      }
    }
    if ((arg === "-c" || arg === "--config") && isProtectedCodexConfigOverride(next)) {
      throw new Error("PrivacyAI reserves the Codex model-provider and transport configuration.");
    }
    if (arg.startsWith("--config=") && isProtectedCodexConfigOverride(arg.slice("--config=".length))) {
      throw new Error("PrivacyAI reserves the Codex model-provider and transport configuration.");
    }
    if ((arg === "-c" || arg === "--config") && enablesProtectedCodexFeature(next)) {
      throw new Error("PrivacyAI cannot enable a provider-hosted Codex feature that bypasses local restoration.");
    }
    if (arg.startsWith("--config=") && enablesProtectedCodexFeature(arg.slice("--config=".length))) {
      throw new Error("PrivacyAI cannot enable a provider-hosted Codex feature that bypasses local restoration.");
    }
    if (valueFlags.has(arg)) index += 1;
  }
}

function validateStrictCodexArguments(args) {
  const blockedFlags = new Set([
    "--search",
    "-i",
    "--image",
    "--add-dir",
    "-p",
    "--profile",
    "--dangerously-bypass-hook-trust",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
  const blockedCommands = new Set(["resume", "fork", "exec", "review", "mcp-server", "app-server"]);
  const valueFlags = new Set([
    "--ask-for-approval",
    "--cd",
    "--disable",
    "--enable",
    "--local-provider",
    "--model",
    "--sandbox",
    "-C",
    "-a",
    "-m",
    "-s"
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    const next = String(args[index + 1] || "");
    if (arg === "--") break;
    if (isCompactShortOption(arg)) {
      throw new Error(
        `PrivacyAI rejects combined or attached Codex short options (${arg}) while prompt-only isolation is active. ` +
        "Pass each short option and its value as separate arguments."
      );
    }
    if (blockedCommands.has(arg)) {
      throw new Error(
        `PrivacyAI cannot launch Codex ${arg} because prior or implicit context bypasses this fresh-session boundary.`
      );
    }
    if (blockedFlags.has(arg) || [...blockedFlags].some(flag => arg.startsWith(`${flag}=`))) {
      throw new Error(`PrivacyAI reserves Codex ${arg.split("=", 1)[0]} while prompt-only isolation is active.`);
    }
    if (arg === "--enable" && next !== "hooks") {
      throw new Error(`PrivacyAI cannot enable Codex feature ${next || "<missing>"} in prompt-only isolation.`);
    }
    if (arg.startsWith("--enable=") && arg.slice("--enable=".length) !== "hooks") {
      throw new Error(
        `PrivacyAI cannot enable Codex feature ${arg.slice("--enable=".length)} in prompt-only isolation.`
      );
    }
    if ((arg === "--disable" && next === "hooks") || arg === "--disable=hooks") {
      throw new Error("PrivacyAI cannot launch Codex with hooks disabled.");
    }
    if ((arg === "-c" || arg === "--config") && /(^|\.)hooks(?:\.|=)|features\.hooks\s*=/.test(next)) {
      throw new Error("PrivacyAI reserves Codex hook configuration while privacy protection is active.");
    }
    if (/^--config=(?:.*\.)?hooks(?:\.|=)|^--config=features\.hooks=/.test(arg)) {
      throw new Error("PrivacyAI reserves Codex hook configuration while privacy protection is active.");
    }
    if (arg === "-c" || arg === "--config" || arg.startsWith("--config=")) {
      throw new Error("PrivacyAI reserves Codex configuration overrides while isolated startup context is active.");
    }
    if (valueFlags.has(arg)) index += 1;
  }
}

function enablesProtectedCodexFeature(value) {
  const assignment = String(value || "").trim();
  const match = assignment.match(/^features\.([A-Za-z0-9_-]+)\s*=\s*(true|1|"true")$/i);
  return Boolean(match && CODEX_GATEWAY_DISABLED_FEATURES.includes(match[1]));
}

function isCompactShortOption(value) {
  return /^-[^-].+/.test(value);
}

function isTruthyEnvironmentValue(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && !new Set(["0", "false", "no", "off"]).has(normalized);
}
