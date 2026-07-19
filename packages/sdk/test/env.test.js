import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromEnv, loadEnvFile } from "../src/index.js";

test("loadEnvFile reads quoted values", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ai-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, 'PRIVATE_AI_BASE_URL="http://localhost:11434/v1"\nPRIVATE_AI_MODEL=qwen3.5:2b\n');

  const env = loadEnvFile(file);

  assert.equal(env.PRIVATE_AI_BASE_URL, "http://localhost:11434/v1");
  assert.equal(env.PRIVATE_AI_MODEL, "qwen3.5:2b");
});

test("configFromEnv prefers PRIVATE_AI aliases", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-ai-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, ".env"),
    "PRIVATE_AI_BASE_URL=http://local.test/v1\nPRIVATE_AI_API_KEY=test-key\nPRIVATE_AI_MODEL=test-model\n"
  );

  const config = configFromEnv({ cwd: dir });

  assert.equal(config.baseURL, "http://local.test/v1");
  assert.equal(config.apiKey, "test-key");
  assert.equal(config.model, "test-model");
});


test("configFromEnv defaults to strict sanitization and accepts an explicit mode", () => {
  const original = process.env.PRIVATE_AI_SANITIZATION_MODE;
  try {
    delete process.env.PRIVATE_AI_SANITIZATION_MODE;
    assert.equal(configFromEnv({ loadEnv: false }).sanitizationMode, "strict");

    process.env.PRIVATE_AI_SANITIZATION_MODE = "browser";
    assert.equal(configFromEnv({ loadEnv: false }).sanitizationMode, "browser");
  } finally {
    if (original === undefined) delete process.env.PRIVATE_AI_SANITIZATION_MODE;
    else process.env.PRIVATE_AI_SANITIZATION_MODE = original;
  }
});

test("configFromEnv uses the shared 8192-token local context default", () => {
  const original = process.env.PRIVATE_AI_NUM_CTX;
  try {
    delete process.env.PRIVATE_AI_NUM_CTX;
    assert.equal(configFromEnv({ loadEnv: false }).numCtx, 8192);
  } finally {
    if (original === undefined) delete process.env.PRIVATE_AI_NUM_CTX;
    else process.env.PRIVATE_AI_NUM_CTX = original;
  }
});

test("configFromEnv validates local-model concurrency and Ollama keep-alive", () => {
  const originalConcurrency = process.env.PRIVATE_AI_CLASSIFIER_CONCURRENCY;
  const originalKeepAlive = process.env.PRIVATE_AI_OLLAMA_KEEP_ALIVE;
  try {
    process.env.PRIVATE_AI_CLASSIFIER_CONCURRENCY = "2";
    process.env.PRIVATE_AI_OLLAMA_KEEP_ALIVE = "30m";
    const config = configFromEnv({ loadEnv: false });
    assert.equal(config.classifierConcurrency, 2);
    assert.equal(config.keepAlive, "30m");

    process.env.PRIVATE_AI_CLASSIFIER_CONCURRENCY = "3";
    assert.throws(() => configFromEnv({ loadEnv: false }), /Classifier concurrency/);
    process.env.PRIVATE_AI_CLASSIFIER_CONCURRENCY = "1";
    process.env.PRIVATE_AI_OLLAMA_KEEP_ALIVE = "25h";
    assert.throws(() => configFromEnv({ loadEnv: false }), /between 0 and 24 hours/);
  } finally {
    if (originalConcurrency === undefined) delete process.env.PRIVATE_AI_CLASSIFIER_CONCURRENCY;
    else process.env.PRIVATE_AI_CLASSIFIER_CONCURRENCY = originalConcurrency;
    if (originalKeepAlive === undefined) delete process.env.PRIVATE_AI_OLLAMA_KEEP_ALIVE;
    else process.env.PRIVATE_AI_OLLAMA_KEEP_ALIVE = originalKeepAlive;
  }
});
