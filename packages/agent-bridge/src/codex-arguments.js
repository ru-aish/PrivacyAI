export const CODEX_VALUE_OPTIONS = new Set([
  "--add-dir",
  "--ask-for-approval",
  "--cd",
  "--config",
  "--disable",
  "--enable",
  "--image",
  "--local-provider",
  "--model",
  "--profile",
  "--remote-auth-token-env",
  "--sandbox",
  "-C",
  "-a",
  "-c",
  "-i",
  "-m",
  "-p",
  "-s"
]);

export function splitCodexArguments(args = []) {
  const normalized = Array.from(args, value => String(value));
  const delimiterIndex = normalized.indexOf("--");
  if (delimiterIndex === -1) {
    return { beforeDelimiter: normalized, afterDelimiter: [], hasDelimiter: false };
  }
  return {
    beforeDelimiter: normalized.slice(0, delimiterIndex),
    afterDelimiter: normalized.slice(delimiterIndex + 1),
    hasDelimiter: true
  };
}

export function joinCodexArguments(parts) {
  return parts.hasDelimiter
    ? [...parts.beforeDelimiter, "--", ...parts.afterDelimiter]
    : [...parts.beforeDelimiter];
}

export function firstCodexCommand(args = [], valueOptions = CODEX_VALUE_OPTIONS) {
  const { beforeDelimiter } = splitCodexArguments(args);
  for (let index = 0; index < beforeDelimiter.length; index += 1) {
    const arg = beforeDelimiter[index];
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 0 && valueOptions.has(arg.slice(0, equalsIndex))) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function codexWorkingDirectory(args = [], fallback = process.cwd()) {
  const { beforeDelimiter } = splitCodexArguments(args);
  for (let index = 0; index < beforeDelimiter.length; index += 1) {
    const arg = beforeDelimiter[index];
    if ((arg === "-C" || arg === "--cd") && beforeDelimiter[index + 1]) {
      return beforeDelimiter[index + 1];
    }
    if (arg.startsWith("--cd=")) return arg.slice("--cd=".length);
  }
  return fallback;
}
