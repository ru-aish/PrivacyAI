import { resolveExecutable } from "./executable.js";
import { launchNativeTui } from "./launcher.js";
import { validateNativeArguments } from "./native-argument-policy.js";
import { defineProviderAdapter } from "./provider-adapter.js";

export const claudeProviderAdapter = defineProviderAdapter({
  id: "claude",
  aliases: [],
  displayName: "Claude Code",
  executable: "claude",
  defaultMode: "hooks",
  modes: {
    hooks: {
      transport: null,
      streaming: true,
      hookSemantics: "native-pretool-and-prompt-hooks",
      unsupportedCapabilities: ["hook-bypass", "remote-hook-override"]
    }
  },
  parseArguments(args) {
    validateNativeArguments("claude", args);
    return Object.freeze({ mode: "hooks", args: Object.freeze([...args]) });
  },
  resolveExecutable(options = {}) {
    const resolver = options.resolveExecutable || resolveExecutable;
    return resolver("claude", options);
  },
  invoke(args, context = {}) {
    const launch = context.launch || context.launchNativeTui || launchNativeTui;
    const launchOptions = { ...(context.providerOptions || context.launchOptions) };
    return launch("claude", args, launchOptions);
  }
});
