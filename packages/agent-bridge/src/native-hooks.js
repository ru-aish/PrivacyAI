import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PROMPT_HOOK_PATH = fileURLToPath(new URL("../bin/privacyai-prompt-hook.js", import.meta.url));
const AGENT_HOOK_PATH = fileURLToPath(new URL("../bin/privacyai-agent-hook.js", import.meta.url));

export function hookCommands(options = {}) {
  const nodePath = options.nodePath || process.execPath;
  return {
    prompt: `${shellQuote(nodePath)} ${shellQuote(PROMPT_HOOK_PATH)}`,
    agent: `${shellQuote(nodePath)} ${shellQuote(AGENT_HOOK_PATH)}`
  };
}

export async function writeClaudeSettings(path, options = {}) {
  const commands = hookCommands(options);
  const settings = {
    disableAllHooks: false,
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: commands.prompt, timeout: options.promptTimeout || 180 }
          ]
        }
      ],
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: commands.agent, timeout: options.toolTimeout || 30 }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: commands.agent, timeout: options.toolTimeout || 30 }
          ]
        }
      ],
      PostToolUseFailure: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: commands.agent, timeout: options.toolTimeout || 30 }
          ]
        }
      ],
      PostToolBatch: [
        {
          hooks: [
            { type: "command", command: commands.agent, timeout: options.toolTimeout || 30 }
          ]
        }
      ]
    }
  };
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

export function buildCodexHookDeclarationArgs(options = {}) {
  const commands = hookCommands(options);
  const promptTimeout = Number(options.promptTimeout || 180);
  const toolTimeout = Number(options.toolTimeout || 30);

  return [
    "--enable",
    "hooks",
    "-c",
    `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${tomlString(commands.prompt)},timeout=${promptTimeout}}]}]`,
    "-c",
    `hooks.PreToolUse=[{matcher="^.*$",hooks=[{type="command",command=${tomlString(commands.agent)},timeout=${toolTimeout}}]}]`,
    "-c",
    `hooks.PostToolUse=[{matcher="^.*$",hooks=[{type="command",command=${tomlString(commands.agent)},timeout=${toolTimeout}}]}]`
  ];
}

export async function discoverCodexHookTrust(options) {
  const codexPath = options.codexPath;
  const declarationArgs = options.declarationArgs || buildCodexHookDeclarationArgs(options);
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const timeoutMs = options.timeoutMs || 15000;

  const response = await requestCodexHooksList({
    codexPath,
    args: [...declarationArgs, "app-server"],
    cwd,
    env,
    timeoutMs
  });

  const hooks = response?.result?.data?.flatMap(item => item.hooks || []) || [];
  const sessionHooks = hooks.filter(
    hook => hook.source === "sessionFlags" && typeof hook.key === "string" && hook.currentHash
  );
  const requiredEvents = new Set(["userPromptSubmit", "preToolUse", "postToolUse"]);
  for (const hook of sessionHooks) requiredEvents.delete(hook.eventName);
  if (requiredEvents.size > 0) {
    throw new Error(`Codex did not discover required PrivacyAI hooks: ${[...requiredEvents].join(", ")}`);
  }

  const entries = sessionHooks.map(
    hook => `${tomlString(hook.key)}={enabled=true,trusted_hash=${tomlString(hook.currentHash)}}`
  );
  return {
    hooks: sessionHooks,
    stateArgs: ["-c", `hooks.state={${entries.join(",")}}`]
  };
}

function requestCodexHooksList({ codexPath, args, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error("Timed out while asking Codex to validate PrivacyAI hooks."));
    }, timeoutMs);

    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message || "Codex hooks/list failed."));
          else finish(null, message);
        }
      }
    });
    child.on("exit", code => {
      if (!settled) {
        finish(new Error(`Codex hook validation exited with code ${code}. ${safeDiagnostic(stderr)}`));
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "privacyai", title: "PrivacyAI", version: "0.1.0" }
        }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "hooks/list", id: 2, params: { cwds: [cwd] } })}\n`);
  });
}

export function codexEffectiveCwd(args, fallback = process.cwd()) {
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "-C" || args[index] === "--cd") && args[index + 1]) {
      return args[index + 1];
    }
    if (args[index].startsWith("--cd=")) return args[index].slice(5);
  }
  return fallback;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function safeDiagnostic(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.slice(-500) : "";
}
