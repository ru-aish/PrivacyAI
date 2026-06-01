import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromEnv, loadEnvFile } from "../src/index.js";

test("loadEnvFile reads quoted values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ai-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, 'PRIVATE_AI_BASE_URL="http://localhost:11434/v1"\nPRIVATE_AI_MODEL=qwen3.5:2b\n');

  const env = loadEnvFile(file);

  assert.equal(env.PRIVATE_AI_BASE_URL, "http://localhost:11434/v1");
  assert.equal(env.PRIVATE_AI_MODEL, "qwen3.5:2b");
});

test("configFromEnv prefers PRIVATE_AI aliases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ai-env-"));
  fs.writeFileSync(
    path.join(dir, ".env"),
    "PRIVATE_AI_BASE_URL=http://local.test/v1\nPRIVATE_AI_API_KEY=test-key\nPRIVATE_AI_MODEL=test-model\n"
  );

  const config = configFromEnv({ cwd: dir });

  assert.equal(config.baseURL, "http://local.test/v1");
  assert.equal(config.apiKey, "test-key");
  assert.equal(config.model, "test-model");
});

