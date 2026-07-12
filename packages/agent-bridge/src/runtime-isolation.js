import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CODEX_ISOLATED_FEATURES = Object.freeze([
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "image_generation",
  "multi_agent",
  "code_mode",
  "code_mode_host",
  "shell_tool",
  "unified_exec",
  "remote_plugin",
  "plugin_sharing",
  "workspace_dependencies",
  "tool_call_mcp_elicitation"
]);

const CODEX_CREDENTIAL_FILES = Object.freeze(["auth.json", "installation_id"]);
const CLAUDE_CREDENTIAL_FILES = Object.freeze([".credentials.json", "credentials.json", "auth.json"]);

export function buildCodexIsolationArgs() {
  return CODEX_ISOLATED_FEATURES.flatMap(feature => ["--disable", feature]);
}

export async function prepareAgentRuntimeIsolation(flavor, runtimeDir, options = {}) {
  if (flavor === "codex") return prepareCodexIsolation(runtimeDir, options);
  if (flavor === "claude") return prepareClaudeIsolation(runtimeDir, options);
  throw new TypeError(`Unsupported native agent isolation flavor: ${flavor}`);
}

async function prepareCodexIsolation(runtimeDir, options) {
  const targetHome = resolve(runtimeDir, "codex-home");
  const sourceHome = resolve(
    options.codexHome || options.env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex")
  );
  await createPrivateDirectory(targetHome);
  await copyCredentialFiles(sourceHome, targetHome, CODEX_CREDENTIAL_FILES);

  return {
    env: { CODEX_HOME: targetHome },
    args: buildCodexIsolationArgs(),
    sourceHome,
    targetHome
  };
}

async function prepareClaudeIsolation(runtimeDir, options) {
  const targetHome = resolve(runtimeDir, "claude-home");
  const sourceHome = resolve(
    options.claudeConfigDir ||
      options.env?.CLAUDE_CONFIG_DIR ||
      process.env.CLAUDE_CONFIG_DIR ||
      join(homedir(), ".claude")
  );
  await createPrivateDirectory(targetHome);
  await copyCredentialFiles(sourceHome, targetHome, CLAUDE_CREDENTIAL_FILES);

  const emptyMcpPath = resolve(runtimeDir, "empty-mcp.json");
  await writeFile(emptyMcpPath, "{}\n", { mode: 0o600 });

  return {
    env: { CLAUDE_CONFIG_DIR: targetHome },
    args: [
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--mcp-config",
      emptyMcpPath,
      "--disable-slash-commands"
    ],
    sourceHome,
    targetHome,
    emptyMcpPath
  };
}

async function createPrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function copyCredentialFiles(sourceDir, targetDir, names) {
  for (const name of names) {
    const source = join(sourceDir, name);
    const target = join(targetDir, name);
    if (!(await isRegularReadableFile(source))) continue;
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    await chmod(target, 0o600);
  }
}

async function isRegularReadableFile(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    await access(path, fsConstants.R_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return false;
    throw error;
  }
}
