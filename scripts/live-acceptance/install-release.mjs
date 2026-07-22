#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  absolute,
  one,
  parseRepeatedArgs,
  readJson,
  runChecked,
  writeJson
} from "./common.mjs";

export async function installRelease(options) {
  const cwd = absolute(options.cwd || process.cwd());
  const artifactDir = absolute(options.artifactDir);
  const prefix = absolute(options.prefix);
  await mkdir(artifactDir, { recursive: true });
  await mkdir(prefix, { recursive: true });

  await runChecked(process.execPath, [
    join(cwd, "scripts", "release", "build.mjs"),
    "--output", artifactDir,
    "--require-clean",
    "--no-reproducibility-check"
  ], { cwd, timeoutMs: 15 * 60_000 });

  const metadata = await readJson(join(artifactDir, "release-metadata.json"));
  const tarballs = metadata.publishOrder.map(name => {
    const entry = metadata.packages.find(item => item.name === name);
    if (!entry?.filename) throw new Error(`Release metadata is missing ${name}.`);
    return join(artifactDir, entry.filename);
  });

  await runChecked("npm", [
    "install",
    "--global",
    "--prefix", prefix,
    "--no-audit",
    "--no-fund",
    ...tarballs
  ], {
    cwd,
    timeoutMs: 10 * 60_000,
    env: {
      ...process.env,
      npm_config_cache: join(prefix, ".npm-cache")
    }
  });

  const binary = join(prefix, "bin", "privacyai");
  const version = await runChecked(binary, ["--version"], { cwd, timeoutMs: 30_000 });
  if (version.stdout.trim() !== `privacyai ${metadata.version}`) {
    throw new Error(`Installed release reported an unexpected version: ${version.stdout.trim()}`);
  }

  const result = {
    schemaVersion: 1,
    releaseSha: metadata.gitCommit,
    version: metadata.version,
    tag: metadata.tag,
    binary,
    artifactDir,
    prefix
  };
  await writeJson(join(prefix, "release-install.json"), result);
  return result;
}

async function main() {
  const values = parseRepeatedArgs(process.argv.slice(2));
  const result = await installRelease({
    cwd: one(values, "--cwd", { defaultValue: process.cwd() }),
    artifactDir: one(values, "--artifacts", { required: true }),
    prefix: one(values, "--prefix", { required: true })
  });
  process.stdout.write(`Installed PrivacyAI ${result.version} from ${result.releaseSha}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
