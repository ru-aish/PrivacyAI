import { BoundedQueue } from "./bounded-queue.js";
import { parseCodexPrivacyMode } from "./codex-provider-config.js";
import { resolveExecutable } from "./executable.js";
import { launchNativeTui } from "./launcher.js";
import { validateNativeArguments } from "./native-argument-policy.js";
import { defineProviderAdapter } from "./provider-adapter.js";

export const codexProviderAdapter = defineProviderAdapter({
  id: "codex",
  aliases: [],
  displayName: "Codex",
  executable: "codex",
  defaultMode: "gateway",
  modes: {
    gateway: {
      transport: "loopback-responses-http",
      streaming: true,
      hookSemantics: null,
      unsupportedCapabilities: [
        "remote-provider-override",
        "responses-websocket",
        "provider-hosted-web-search"
      ]
    },
    strict: {
      transport: null,
      streaming: false,
      hookSemantics: "deny-tool-use",
      fallback: true,
      unsupportedCapabilities: [
        "session-resume",
        "session-fork",
        "image-input",
        "tool-execution"
      ]
    }
  },
  parseArguments(args, options = {}) {
    const parsed = parseCodexPrivacyMode(args, { mode: options.mode || options.codexMode });
    validateNativeArguments("codex", parsed.args, { codexMode: parsed.mode });
    return Object.freeze({ mode: parsed.mode, args: Object.freeze([...parsed.args]) });
  },
  resolveExecutable(options = {}) {
    const resolver = options.resolveExecutable || resolveExecutable;
    return resolver("codex", options);
  },
  async invoke(args, context = {}) {
    const launch = providerLauncher(context);
    const launchOptions = { ...(context.providerOptions || context.launchOptions) };
    const stderr = context.stderr || process.stderr;
    if (typeof launchOptions.onGatewayError !== "function") {
      const render = diagnostic => writeGatewayDiagnostic(stderr, diagnostic);
      if (stderr.isTTY) {
        const deferred = new BoundedQueue(
          positiveQueueCapacity(context.maxDeferredGatewayDiagnostics, 128),
          "deferred gateway diagnostics"
        );
        launchOptions.onGatewayError = diagnostic => deferred.push(diagnostic);
        try {
          return await launch("codex", args, launchOptions);
        } finally {
          flushDiagnostics(stderr, deferred, render);
        }
      }
      launchOptions.onGatewayError = render;
    }
    return launch("codex", args, launchOptions);
  }
});

function providerLauncher(context) {
  return context.launch || context.launchNativeTui || launchNativeTui;
}

function flushDiagnostics(output, deferred, render) {
  for (const diagnostic of deferred.drain()) {
    try {
      render(diagnostic);
    } catch {
      // Diagnostic rendering must never replace the launcher result.
    }
  }
  if (deferred.dropped <= 0) return;
  try {
    output.write(`[PrivacyAI] Suppressed ${deferred.dropped} older Codex gateway diagnostics.\n`);
  } catch {
    // Diagnostic rendering must never replace the launcher result.
  }
}

function writeGatewayDiagnostic(output, diagnostic) {
  const code = safeDiagnosticField(diagnostic?.code, "PRIVACYAI_CODEX_GATEWAY_FAILURE");
  const category = safeDiagnosticField(diagnostic?.category, "gateway").toLowerCase();
  output.write(`[PrivacyAI] Codex gateway failure: ${category} (${code}).\n`);
}

function safeDiagnosticField(value, fallback) {
  const text = String(value || "");
  return /^[A-Za-z0-9_]{1,96}$/.test(text) ? text : fallback;
}

function positiveQueueCapacity(value, fallback) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > 10_000) {
    throw new TypeError("Deferred gateway diagnostic capacity must be between 1 and 10000.");
  }
  return normalized;
}
