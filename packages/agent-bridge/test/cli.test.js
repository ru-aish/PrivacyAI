import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { printHelp, runPrivacyAiCli } from "../src/cli.js";

test("CLI help directs resume and fork through the protected wrapper", () => {
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });

  printHelp(output);

  assert.match(text, /privacyai codex resume <id>/);
  assert.match(text, /never use raw codex resume/);
  assert.match(text, /privacyai codex fork <id>/);
  assert.match(text, /never use raw codex fork/);
  assert.match(text, /Unix-like Codex TUI: \/resume/);
  assert.match(text, /\/fork \[--all\|--last\|id\]/);
});

test("Codex CLI prints only structured privacy-safe gateway diagnostics", async () => {
  const stderr = new PassThrough();
  let text = "";
  stderr.on("data", chunk => {
    text += chunk.toString();
  });

  const code = await runPrivacyAiCli(["codex"], {
    stderr,
    launchNativeTui: async (flavor, args, options) => {
      assert.equal(flavor, "codex");
      assert.deepEqual(args, []);
      options.onGatewayError({
        code: "PRIVACYAI_LOCAL_MODEL_FAILURE",
        category: "local_model",
        message: "must not be printed",
        private: "private@example.test"
      });
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.equal(
    text,
    "[PrivacyAI] Codex gateway failure: local_model (PRIVACYAI_LOCAL_MODEL_FAILURE).\n"
  );
  assert.equal(text.includes("private@example.test"), false);
  assert.equal(text.includes("must not be printed"), false);
});

test("Codex CLI sanitizes malformed diagnostic fields", async () => {
  const stderr = new PassThrough();
  let text = "";
  stderr.on("data", chunk => {
    text += chunk.toString();
  });

  await runPrivacyAiCli(["codex"], {
    stderr,
    launchNativeTui: async (_flavor, _args, options) => {
      options.onGatewayError({
        code: "private@example.test",
        category: "/home/private/workspace"
      });
      return 0;
    }
  });

  assert.equal(
    text,
    "[PrivacyAI] Codex gateway failure: gateway (PRIVACYAI_CODEX_GATEWAY_FAILURE).\n"
  );
});

test("Codex CLI defers TUI diagnostics but keeps non-TTY output immediate", async () => {
  const stderr = new PassThrough();
  Object.defineProperty(stderr, "isTTY", { value: true });
  let text = "";
  stderr.on("data", chunk => { text += chunk.toString(); });
  await runPrivacyAiCli(["codex"], {
    stderr,
    launchNativeTui: async (_flavor, _args, options) => {
      options.onGatewayError({ code: "PRIVACYAI_CODEX_UPSTREAM_RESET", category: "upstream_reset" });
      assert.equal(text, "");
      return 0;
    }
  });
  assert.match(text, /upstream_reset \(PRIVACYAI_CODEX_UPSTREAM_RESET\)/);
});


test("Codex CLI flushes deferred TUI diagnostics when the launcher fails", async () => {
  const stderr = new PassThrough();
  Object.defineProperty(stderr, "isTTY", { value: true });
  let text = "";
  stderr.on("data", chunk => { text += chunk.toString(); });

  const code = await runPrivacyAiCli(["codex"], {
    stderr,
    launchNativeTui: async (_flavor, _args, options) => {
      options.onGatewayError({
        code: "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT",
        category: "timeout"
      });
      throw new Error("launcher failed safely");
    }
  });

  assert.equal(code, 1);
  assert.match(text, /timeout \(PRIVACYAI_CODEX_UPSTREAM_TIMEOUT\)/);
  assert.match(text, /launcher failed safely/);
});
