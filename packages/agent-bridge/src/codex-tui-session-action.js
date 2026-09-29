import { firstCodexCommand, splitCodexArguments } from "./codex-arguments.js";

export const CODEX_TUI_SESSION_ACTION_EXIT_CODE = 86;

const SESSION_ACTIONS = new Set(["resume", "fork"]);
const SESSION_SELECTORS = new Set(["--last", "--all"]);
const HELP_VERSION_FLAGS = new Set(["--help", "-h", "--version", "-V"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const PERSISTENT_VALUE_OPTIONS = new Set([
  "--add-dir",
  "--ask-for-approval",
  "--cd",
  "--config",
  "--disable",
  "--enable",
  "--model",
  "--sandbox",
  "-C",
  "-a",
  "-c",
  "-m",
  "-s"
]);

const PERSISTENT_BOOLEAN_OPTIONS = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--no-alt-screen",
  "--strict-config"
]);

const NON_INTERACTIVE_COMMANDS = new Set([
  "app-server",
  "a",
  "apply",
  "archive",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "e",
  "exec",
  "exec-server",
  "features",
  "help",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "plugin",
  "remote-control",
  "review",
  "sandbox",
  "unarchive",
  "update"
]);

export function parseCodexTuiSessionActionRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.version !== 1 || !SESSION_ACTIONS.has(record.action)) return null;

  const selector = record.selector == null ? null : String(record.selector);
  if (
    selector !== null &&
    !SESSION_SELECTORS.has(selector) &&
    !SESSION_ID_PATTERN.test(selector)
  ) {
    return null;
  }

  return {
    action: record.action,
    selector
  };
}

export function buildCodexTuiSessionActionArgs(originalArgs, action) {
  const parsed = parseCodexTuiSessionActionRecord({ version: 1, ...action });
  if (!parsed) throw new TypeError("Invalid protected Codex TUI session action.");

  const args = [
    ...persistentCodexOptions(originalArgs),
    parsed.action
  ];
  if (parsed.selector) args.push(parsed.selector);
  return args;
}

export function supportsCodexTuiSessionActions(args = []) {
  const { beforeDelimiter } = splitCodexArguments(args);
  if (beforeDelimiter.some(arg => HELP_VERSION_FLAGS.has(arg))) return false;

  const command = firstCodexPositional(args);
  return command === null || !NON_INTERACTIVE_COMMANDS.has(command);
}

function persistentCodexOptions(args = []) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "--") break;

    if (PERSISTENT_VALUE_OPTIONS.has(arg)) {
      if (index + 1 < args.length) {
        result.push(arg, String(args[index + 1]));
        index += 1;
      }
      continue;
    }

    if (PERSISTENT_BOOLEAN_OPTIONS.has(arg)) {
      result.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 0) {
      const flag = arg.slice(0, equalsIndex);
      if (PERSISTENT_VALUE_OPTIONS.has(flag)) result.push(arg);
    }
  }
  return result;
}

function firstCodexPositional(args = []) {
  return firstCodexCommand(args, PERSISTENT_VALUE_OPTIONS);
}
