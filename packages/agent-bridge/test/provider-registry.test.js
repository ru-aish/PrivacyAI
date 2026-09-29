import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { isPrivacyError } from "@privacy-ai/sdk";
import { getProviderAdapter as getRootProviderAdapter } from "@privacy-ai/agent-bridge";
import {
  getProviderAdapter,
  listProviderAdapters,
  requireProviderAdapter
} from "@privacy-ai/agent-bridge/providers";

const REQUIRED_METHODS = Object.freeze([
  "parseArguments",
  "resolveExecutable",
  "invoke"
]);

test("provider registry exposes immutable Claude, Codex, and Antigravity contracts", () => {
  const providers = listProviderAdapters();
  assert.deepEqual(providers.map(provider => provider.id), ["claude", "codex", "antigravity"]);
  assert.equal(Object.isFrozen(providers), true);

  for (const provider of providers) {
    assert.equal(Object.isFrozen(provider), true);
    assert.equal(Object.isFrozen(provider.aliases), true);
    assert.equal(Object.isFrozen(provider.modes), true);
    assert.ok(Object.hasOwn(provider.modes, provider.defaultMode));
    for (const method of REQUIRED_METHODS) assert.equal(typeof provider[method], "function");
    for (const mode of Object.values(provider.modes)) {
      assert.equal(Object.isFrozen(mode), true);
      assert.equal(Object.isFrozen(mode.unsupportedCapabilities), true);
      assert.ok(mode.unsupportedCapabilities.length > 0);
    }
  }
});

test("provider registry resolves compatibility aliases without duplicating adapters", () => {
  const claude = getProviderAdapter("claude");
  const codex = getProviderAdapter("codex");
  const antigravity = getProviderAdapter("antigravity");

  assert.equal(getRootProviderAdapter("claude"), claude);
  assert.equal(getRootProviderAdapter("codex"), codex);
  assert.equal(getProviderAdapter(" CODEX "), codex);
  assert.equal(getProviderAdapter("agy"), antigravity);
  assert.equal(getProviderAdapter("ANTIGRAVITY"), antigravity);
  assert.equal(getProviderAdapter("unknown"), null);
  assert.equal(getProviderAdapter(null), null);
});

test("unsupported providers use the shared PrivacyAI error contract", () => {
  assert.throws(
    () => requireProviderAdapter("unknown"),
    error => {
      assert.equal(isPrivacyError(error), true);
      assert.equal(error.code, "PRIVACYAI_UNSUPPORTED_AGENT_PROVIDER");
      assert.equal(error.category, "internal");
      assert.equal(error.phase, "startup");
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /\[object Object\]/);
      return true;
    }
  );
});

test("provider adapters preserve provider-specific argument policy", () => {
  const claude = requireProviderAdapter("claude");
  assert.deepEqual(claude.parseArguments(["hello"]), {
    mode: "hooks",
    args: ["hello"]
  });
  assert.throws(() => claude.parseArguments(["--dangerously-skip-permissions"]), /reserves Claude --dangerously-skip-permissions/);

  const codex = requireProviderAdapter("codex");
  assert.deepEqual(codex.parseArguments(["exec", "hello"]), {
    mode: "gateway",
    args: ["exec", "hello"]
  });
  assert.deepEqual(codex.parseArguments(["--privacy-strict", "hello"]), {
    mode: "strict",
    args: ["hello"]
  });
  assert.throws(
    () => codex.parseArguments(["--privacy-strict", "resume", "--last"]),
    /fresh-session boundary/
  );

  const antigravity = requireProviderAdapter("agy");
  assert.deepEqual(
    antigravity.parseArguments(["--conversation", "session-1"], { futureOption: true }),
    {
      mode: "transport",
      args: ["--conversation", "session-1"]
    }
  );
  assert.deepEqual(antigravity.parseArguments(["--privacy-strict", "--print", "hello"]), {
    mode: "strict",
    args: ["--print", "hello"]
  });
  assert.throws(
    () => antigravity.parseArguments(["--privacy-strict", "--continue", "--print", "hello"]),
    /cannot launch AGY/
  );
});

test("provider adapters normalize executable discovery", async () => {
  const calls = [];
  const resolver = async (name, options) => {
    calls.push({ name, marker: options.marker });
    return `/test/${name}`;
  };

  assert.equal(
    await requireProviderAdapter("claude").resolveExecutable({ resolveExecutable: resolver, marker: 0 }),
    "/test/claude"
  );
  assert.equal(
    await requireProviderAdapter("codex").resolveExecutable({ resolveExecutable: resolver, marker: 1 }),
    "/test/codex"
  );
  assert.equal(
    await requireProviderAdapter("antigravity").resolveExecutable({ resolveExecutable: resolver, marker: 2 }),
    "/test/agy"
  );
  assert.deepEqual(calls, [
    { name: "claude", marker: 0 },
    { name: "codex", marker: 1 },
    { name: "agy", marker: 2 }
  ]);
});

test("provider adapters invoke existing launchers through one contract", async () => {
  const claudeOptions = { marker: "claude-options" };
  const claudeResult = await requireProviderAdapter("claude").invoke(["--continue"], {
    launchOptions: claudeOptions,
    launch: async (flavor, args, options) => {
      assert.equal(flavor, "claude");
      assert.deepEqual(args, ["--continue"]);
      assert.notEqual(options, claudeOptions);
      assert.equal(options.marker, "claude-options");
      return 11;
    }
  });
  assert.equal(claudeResult, 11);

  const stderr = new PassThrough();
  let diagnostics = "";
  stderr.on("data", chunk => { diagnostics += chunk.toString(); });
  const codexOptions = { marker: "codex-options" };
  const codexResult = await requireProviderAdapter("codex").invoke(["exec", "hello"], {
    stderr,
    providerOptions: codexOptions,
    launch: async (flavor, args, options) => {
      assert.equal(flavor, "codex");
      assert.deepEqual(args, ["exec", "hello"]);
      assert.equal(options.marker, "codex-options");
      assert.notEqual(options, codexOptions);
      options.onGatewayError({
        code: "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT",
        category: "timeout",
        private: "must-not-print"
      });
      return 17;
    }
  });
  assert.equal(codexResult, 17);
  assert.equal(
    diagnostics,
    "[PrivacyAI] Codex gateway failure: timeout (PRIVACYAI_CODEX_UPSTREAM_TIMEOUT).\n"
  );
  assert.doesNotMatch(diagnostics, /must-not-print/);

  const agyOptions = { marker: "agy-options" };
  const agyStderr = new PassThrough();
  const agyResult = await requireProviderAdapter("antigravity").invoke(["--continue"], {
    providerOptions: agyOptions,
    stderr: agyStderr,
    launch: async (args, options) => {
      assert.deepEqual(args, ["--continue"]);
      assert.notEqual(options, agyOptions);
      assert.equal(options.marker, "agy-options");
      assert.equal(options.stderr, agyStderr);
      return 23;
    }
  });
  assert.equal(agyResult, 23);
});
