import {
  launchAgy,
  parseAgyArguments,
  parseAgyPrivacyMode,
  resolveAgyExecutable
} from "./agy.js";
import { defineProviderAdapter } from "./provider-adapter.js";

export const antigravityProviderAdapter = defineProviderAdapter({
  id: "antigravity",
  aliases: ["agy"],
  displayName: "Antigravity",
  executable: "agy",
  defaultMode: "transport",
  modes: {
    transport: {
      transport: "authenticated-connect-tls",
      streaming: true,
      hookSemantics: null,
      unsupportedCapabilities: [
        "existing-upstream-proxy",
        "compressed-model-payload",
        "unaudited-model-route"
      ]
    },
    strict: {
      transport: null,
      streaming: false,
      hookSemantics: "deny-tool-use",
      fallback: true,
      unsupportedCapabilities: [
        "interactive-session",
        "conversation-resume",
        "tool-execution"
      ]
    }
  },
  parseArguments(args) {
    const parsed = parseAgyPrivacyMode(args);
    if (parsed.mode === "strict") parseAgyArguments(parsed.args);
    return Object.freeze({ mode: parsed.mode, args: Object.freeze([...parsed.args]) });
  },
  resolveExecutable(options = {}) {
    return resolveAgyExecutable(options);
  },
  invoke(args, context = {}) {
    const launch = context.launch || context.launchAgy || launchAgy;
    const launchOptions = { ...(context.providerOptions || context.agyOptions) };
    if (context.stderr && !Object.hasOwn(launchOptions, "stderr")) {
      launchOptions.stderr = context.stderr;
    }
    return launch(args, launchOptions);
  }
});
