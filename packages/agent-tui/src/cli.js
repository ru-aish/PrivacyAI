import { loadBridgeCli, loadBridgeModule } from "./bridge.js";

export const PRIVACYAI_CLI_VERSION = "0.0.2";
export const CLI_EXIT_CODES = Object.freeze({
  success: 0,
  failure: 1,
  usage: 2,
  configurationRequired: 3,
  notFound: 4
});

const CANONICAL_AGENTS = new Set(["claude", "codex", "agy"]);
const COMPATIBILITY_AGENTS = new Set([...CANONICAL_AGENTS, "antigravity"]);

export async function runPrivacyAiCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const stdin = options.stdin || process.stdin;
  const [command, ...args] = argv;

  try {
    if (command == null || command === "--help" || command === "-h") {
      printHelp(stdout);
      return CLI_EXIT_CODES.success;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      requireNoArguments(args, "version");
      stdout.write(`privacyai ${options.version || PRIVACYAI_CLI_VERSION}\n`);
      return CLI_EXIT_CODES.success;
    }
    if (command === "help") {
      requireAtMostOneArgument(args, "help");
      printCommandHelp(args[0], stdout);
      return CLI_EXIT_CODES.success;
    }

    if (command === "agent") {
      if (args.length === 0) {
        printAgentHelp(stderr);
        return CLI_EXIT_CODES.usage;
      }
      if (isHelpRequest(args)) {
        printAgentHelp(stdout);
        return CLI_EXIT_CODES.success;
      }
      const [agent, ...agentArgs] = args;
      if (!CANONICAL_AGENTS.has(agent)) {
        throw usageError(`Unknown PrivacyAI agent: ${agent}`);
      }
      return await delegateToBridge([agent, ...agentArgs], options, stdout, stderr, stdin);
    }

    if (COMPATIBILITY_AGENTS.has(command)) {
      return await delegateToBridge([command, ...args], options, stdout, stderr, stdin);
    }

    if (command === "onboard" || command === "setup") {
      if (isHelpRequest(args)) {
        printOnboardHelp(stdout);
        return CLI_EXIT_CODES.success;
      }
      requireNoArguments(args, command);
      if (options.requireInteractive !== false && (!stdin.isTTY || !stdout.isTTY)) {
        throw usageError(
          "PrivacyAI onboarding requires an interactive terminal. Run it from a TTY."
        );
      }
      return await delegateToBridge(["onboard"], options, stdout, stderr, stdin);
    }

    if (command === "doctor" || command === "diagnostics") {
      if (isHelpRequest(args)) {
        printDoctorHelp(stdout);
        return CLI_EXIT_CODES.success;
      }
      return await runDoctor(args, { ...options, stdout, stderr });
    }

    if (command === "cache") {
      if (isHelpRequest(args)) {
        printCacheHelp(stdout);
        return CLI_EXIT_CODES.success;
      }
      return await runCache(args, { ...options, stdout, stderr });
    }

    if (command === "lineage") {
      if (isHelpRequest(args)) {
        printLineageHelp(stdout);
        return CLI_EXIT_CODES.success;
      }
      return await runLineage(args, { ...options, stdout, stderr });
    }

    throw usageError(`Unknown PrivacyAI command: ${command}`);
  } catch (error) {
    const exitCode = exitCodeForError(error);
    stderr.write(`${safeMessage(error)}\n`);
    if (exitCode === CLI_EXIT_CODES.usage) stderr.write("Run: privacyai --help\n");
    return exitCode;
  }
}

export function printHelp(output = process.stdout) {
  output.write("PrivacyAI protected agent shell\n\n");
  output.write("Usage:\n");
  output.write("  privacyai <command> [options]\n\n");
  output.write("Product commands:\n");
  output.write("  privacyai onboard               Configure the local privacy model\n");
  output.write("  privacyai doctor [--json]       Check configuration, model, agents, and local state\n");
  output.write("  privacyai agent <name> [...]    Launch claude, codex, or agy through PrivacyAI\n");
  output.write("  privacyai cache [command]       Inspect protected cache metadata\n");
  output.write("  privacyai lineage [command]     Inspect session and mutation lineage\n\n");
  output.write("Compatibility aliases:\n");
  output.write("  claude|codex|agy [...]  Equivalent to privacyai agent <name> [...]\n");
  output.write("  antigravity [...]       Alias for agy\n");
  output.write("  setup                   Alias for onboard\n");
  output.write("  diagnostics             Alias for doctor\n\n");
  output.write("Inspection safety:\n");
  output.write("  Cache and lineage commands are read-only and never print stored originals.\n\n");
  output.write("Other:\n");
  output.write("  help [command]        Show command help\n");
  output.write("  --version             Print the CLI version\n\n");
  output.write("Run `privacyai help <command>` for details.\n");
}

async function delegateToBridge(argv, options, stdout, stderr, stdin) {
  const bridgeCli = await loadBridgeCli(options.bridgeCli);
  const code = await bridgeCli.runPrivacyAiCli(argv, {
    ...options.bridgeOptions,
    stdout,
    stderr,
    stdin
  });
  return normalizeExitCode(code);
}

async function runDoctor(args, options) {
  const flags = parseDoctorArguments(args);
  const bridge = await loadBridgeModule(options.bridgeModule);
  const loaded = await bridge.loadPrivacyConfig({ path: options.configPath });
  const agents = await inspectAgents(bridge, options);

  let model = { ok: false, reason: "PrivacyAI is not configured." };
  if (loaded.configured) {
    model = await bridge.checkPrivacyModel(loaded.config, {
      probeCompletion: true,
      ...options.healthOptions
    });
  }

  const brokenAgent = agents.some(agent => agent.installed && !agent.ok);
  const result = {
    ok: Boolean(loaded.configured && model.ok && !brokenAgent),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    configuration: {
      configured: loaded.configured,
      path: loaded.path,
      provider: loaded.config?.provider || null,
      model: loaded.config?.model || null
    },
    localModel: model,
    agents
  };

  if (flags.json) writeJson(options.stdout, result);
  else writeDoctor(options.stdout, result);

  if (!loaded.configured) return CLI_EXIT_CODES.configurationRequired;
  return result.ok ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.failure;
}

async function inspectAgents(bridge, options) {
  const definitions = [
    { name: "claude", candidates: ["claude"] },
    { name: "codex", candidates: ["codex"] },
    { name: "agy", candidates: ["agy", "antigravity"] }
  ];

  return Promise.all(definitions.map(async definition => {
    let binary = null;
    for (const candidate of definition.candidates) {
      binary = await bridge.resolveExecutable(candidate, { path: options.path });
      if (binary) break;
    }
    if (!binary) return { name: definition.name, installed: false, ok: true, binary: null };
    try {
      const probe = await bridge.verifyNativeExecutable(definition.name, binary, {
        ...options.executableProbeOptions
      });
      return {
        name: definition.name,
        installed: true,
        ok: true,
        binary,
        version: probe.version || null
      };
    } catch (error) {
      return {
        name: definition.name,
        installed: true,
        ok: false,
        binary,
        reason: safeMessage(error)
      };
    }
  }));
}

async function runCache(args, options) {
  const request = parseInspectionArguments("cache", args);
  return withInspectionService(options, async service => {
    const result = await service.inspectCache(request);
    if (request.action === "show" && result.entry == null) {
      throw notFoundError("Cache entry not found.");
    }
    if (request.json) writeJson(options.stdout, result);
    else writeCache(options.stdout, result, request);
    return CLI_EXIT_CODES.success;
  });
}

async function runLineage(args, options) {
  const request = parseInspectionArguments("lineage", args);
  return withInspectionService(options, async service => {
    const result = await service.inspectLineage(request);
    if (request.action === "show" && result.session == null) {
      throw notFoundError("Lineage session not found.");
    }
    if (request.json) writeJson(options.stdout, result);
    else writeLineage(options.stdout, result, request);
    return CLI_EXIT_CODES.success;
  });
}

async function withInspectionService(options, operation) {
  if (options.inspectionService) return operation(options.inspectionService);
  const bridge = await loadBridgeModule(options.bridgeModule);
  if (typeof bridge.createCliInspectionService !== "function") {
    throw new TypeError("PrivacyAI agent runtime does not expose CLI inspection services.");
  }
  const service = await bridge.createCliInspectionService({
    verificationDbPath: options.verificationDbPath
  });
  try {
    return await operation(service);
  } finally {
    await service.close?.();
  }
}

function parseDoctorArguments(args) {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw usageError(`Unknown doctor option: ${arg}`);
  }
  return { json };
}

function parseInspectionArguments(kind, args) {
  let action = "summary";
  let actionSet = false;
  let key = null;
  let limit = 10;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--limit") {
      const value = args[++index];
      if (value == null) throw usageError("--limit requires a value.");
      limit = parseLimit(value);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
      continue;
    }
    if (arg.startsWith("-")) throw usageError(`Unknown ${kind} option: ${arg}`);

    if (!actionSet) {
      action = normalizeInspectionAction(kind, arg);
      actionSet = true;
      continue;
    }
    if (action === "show" && key == null) {
      key = arg;
      continue;
    }
    throw usageError(`Unexpected ${kind} argument: ${arg}`);
  }

  if (action === "show" && !key) {
    throw usageError(`${kind} show requires an identifier.`);
  }
  return { action, key, limit, json };
}

function normalizeInspectionAction(kind, value) {
  const aliases = kind === "cache"
    ? new Map([["summary", "summary"], ["stats", "summary"], ["list", "list"], ["show", "show"], ["inspect", "show"]])
    : new Map([["summary", "summary"], ["stats", "summary"], ["list", "list"], ["show", "show"], ["inspect", "show"], ["mutations", "mutations"]]);
  const action = aliases.get(value);
  if (!action) throw usageError(`Unknown ${kind} command: ${value}`);
  return action;
}

function parseLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw usageError("--limit must be an integer between 1 and 100.");
  }
  return parsed;
}

function writeDoctor(output, result) {
  output.write(`PrivacyAI doctor: ${result.ok ? "ready" : "attention required"}\n`);
  output.write(`Platform: ${result.platform} ${result.architecture} (${result.node})\n`);
  output.write(`Configuration: ${result.configuration.configured ? result.configuration.path : "missing"}\n`);
  if (result.configuration.configured) {
    output.write(`Privacy model: ${result.configuration.provider}/${result.configuration.model}\n`);
  }
  output.write(`Local model: ${result.localModel.ok ? "ready" : result.localModel.reason}\n`);
  for (const agent of result.agents) {
    const state = !agent.installed ? "not installed" : agent.ok ? "ready" : agent.reason;
    output.write(`Agent ${agent.name}: ${state}\n`);
  }
}

function writeCache(output, result, request) {
  if (request.action === "summary") {
    output.write(`Cache entries: ${result.summary.entry_count}\n`);
    output.write(`Cache hits: ${result.summary.hit_count}\n`);
    for (const artifact of result.artifacts) {
      output.write(`  ${artifact.artifact_type}: ${artifact.entry_count} entries, ${artifact.hit_count} hits\n`);
    }
    return;
  }
  if (request.action === "list") {
    if (result.entries.length === 0) output.write("No cache entries.\n");
    for (const entry of result.entries) {
      output.write(`${entry.cache_key}  ${entry.artifact_type}  hits=${entry.hit_count}  last=${entry.last_used_at}\n`);
    }
    return;
  }
  const entry = result.entry;
  output.write(`Cache key: ${entry.cache_key}\n`);
  output.write(`Content hash: ${entry.content_hash}\n`);
  output.write(`Artifact type: ${entry.artifact_type}\n`);
  output.write(`Policy fingerprint: ${entry.policy_fingerprint}\n`);
  output.write(`Session-map additions: ${entry.additionCount}\n`);
  output.write(`Hits: ${entry.hit_count}\n`);
}

function writeLineage(output, result, request) {
  if (request.action === "summary") {
    output.write(`Sessions: ${result.summary.sessions}\n`);
    output.write(`Session items: ${result.summary.sessionItems}\n`);
    output.write(`Worktrees: ${result.summary.worktrees}\n`);
    output.write(`Manifests: ${result.summary.manifests}\n`);
    output.write(`Mutations: ${result.summary.mutations}\n`);
    return;
  }
  if (request.action === "list") {
    if (result.sessions.length === 0) output.write("No lineage sessions.\n");
    for (const session of result.sessions) {
      output.write(`${session.session_key}  mappings=${session.mapping_count}  updated=${session.updated_at}\n`);
    }
    return;
  }
  if (request.action === "mutations") {
    if (result.mutations.length === 0) output.write("No recorded mutations.\n");
    for (const mutation of result.mutations) {
      output.write(`${mutation.mutation_id}  ${mutation.status}  ${mutation.operation_type}\n`);
    }
    return;
  }
  const session = result.session;
  output.write(`Session: ${session.session_key}\n`);
  output.write(`Parents: ${session.parent_session_keys.length}\n`);
  output.write(`Mappings: ${session.mapping_count}\n`);
  output.write(`Policy fingerprint: ${session.policy_fingerprint}\n`);
  output.write(`Items: ${session.items.length}\n`);
}

function writeJson(output, value) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printCommandHelp(command, output) {
  switch (command) {
    case undefined:
      printHelp(output);
      break;
    case "agent":
      printAgentHelp(output);
      break;
    case "onboard":
    case "setup":
      printOnboardHelp(output);
      break;
    case "doctor":
    case "diagnostics":
      printDoctorHelp(output);
      break;
    case "cache":
      printCacheHelp(output);
      break;
    case "lineage":
      printLineageHelp(output);
      break;
    case "claude":
    case "codex":
    case "agy":
    case "antigravity":
      printLauncherHelp(command, output);
      break;
    default:
      throw usageError(`Unknown PrivacyAI help topic: ${command}`);
  }
}

function printAgentHelp(output) {
  output.write("Usage: privacyai agent <claude|codex|agy> [agent arguments]\n\n");
  output.write("Launch a supported native agent through PrivacyAI without installing a separate PrivacyAI agent package.\n");
  output.write("Direct `privacyai claude`, `privacyai codex`, and `privacyai agy` commands remain compatibility aliases.\n");
}

function printOnboardHelp(output) {
  output.write("Usage: privacyai onboard\n\n");
  output.write("Discover a local Ollama or LM Studio model, verify it, and save PrivacyAI configuration.\n");
  output.write("This command requires an interactive terminal. `privacyai setup` remains a compatibility alias.\n");
}

function printDoctorHelp(output) {
  output.write("Usage: privacyai doctor [--json]\n\n");
  output.write("Check PrivacyAI configuration, local model readiness, native agent executables, and platform details.\n");
  output.write("Exit 3 means onboarding is required; exit 1 means an operational check failed.\n");
}

function printCacheHelp(output) {
  output.write("Usage:\n");
  output.write("  privacyai cache [summary|list] [--limit N] [--json]\n");
  output.write("  privacyai cache show <cache-key> [--json]\n\n");
  output.write("Read protected-cache metadata without creating, migrating, clearing, or exposing stored originals.\n");
}

function printLineageHelp(output) {
  output.write("Usage:\n");
  output.write("  privacyai lineage [summary|list|mutations] [--limit N] [--json]\n");
  output.write("  privacyai lineage show <session-key> [--limit N] [--json]\n\n");
  output.write("Read session and mutation metadata without exposing session-map originals.\n");
}

function printLauncherHelp(agent, output) {
  const canonical = agent === "antigravity" ? "agy" : agent;
  output.write(`Usage: privacyai agent ${canonical} [agent arguments]\n\n`);
  output.write(`The direct \`privacyai ${agent}\` form remains a compatibility alias.\n`);
  if (canonical === "codex") {
    output.write("Resume and fork through PrivacyAI; raw Codex resume/fork bypasses the protected gateway.\n");
  }
}

function requireNoArguments(args, command) {
  if (args.length > 0) throw usageError(`${command} does not accept arguments.`);
}

function requireAtMostOneArgument(args, command) {
  if (args.length > 1) throw usageError(`${command} accepts at most one topic.`);
}

function isHelpRequest(args) {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}

function usageError(message) {
  return Object.assign(new Error(message), { code: "PRIVACYAI_CLI_USAGE" });
}

function notFoundError(message) {
  return Object.assign(new Error(message), { code: "PRIVACYAI_INSPECTION_NOT_FOUND" });
}

function exitCodeForError(error) {
  if (error?.name === "AbortError") return 130;
  if (error?.code === "PRIVACYAI_CLI_USAGE") return CLI_EXIT_CODES.usage;
  if (error?.code === "PRIVACYAI_ONBOARDING_REQUIRED") {
    return CLI_EXIT_CODES.configurationRequired;
  }
  if (error?.code === "PRIVACYAI_INSPECTION_NOT_FOUND") return CLI_EXIT_CODES.notFound;
  return CLI_EXIT_CODES.failure;
}

function safeMessage(error) {
  return error instanceof Error && error.message
    ? error.message
    : "PrivacyAI failed safely.";
}

function normalizeExitCode(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255
    ? parsed
    : CLI_EXIT_CODES.failure;
}
