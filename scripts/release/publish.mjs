#!/usr/bin/env node
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  gitHead,
  gitTagCommit,
  NPM_REGISTRY_URL,
  run,
  verifyArtifactDirectory
} from "./lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const metadata = await verifyArtifactDirectory(options.artifacts, {
      expectedTag: options.tag
    });
    const head = await gitHead();
    if (metadata.gitCommit !== head) {
      throw new Error(
        `Artifacts were built from ${metadata.gitCommit}, but this checkout is ${head}.`
      );
    }
    const taggedCommit = await gitTagCommit(options.tag);
    if (taggedCommit !== head) {
      throw new Error(`Release tag ${options.tag} does not point to ${head}.`);
    }

    for (const packageName of metadata.publishOrder) {
      const packageEntry = metadata.packages.find(entry => entry.name === packageName);
      if (options.dryRun) {
        await publishDryRun(options.artifacts, packageEntry, metadata.npmDistTag);
        process.stdout.write(`Dry-run passed for ${packageName}@${metadata.version}.\n`);
        continue;
      }
      await publishOrVerifyExisting(options.artifacts, packageEntry, metadata.npmDistTag);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function publishOrVerifyExisting(artifacts, packageEntry, npmDistTag) {
  const existingIntegrity = await readRegistryIntegrity(packageEntry.name, packageEntry.version);
  if (existingIntegrity) {
    if (existingIntegrity !== packageEntry.integrity) {
      throw new Error(
        `${packageEntry.name}@${packageEntry.version} already exists with different bytes. ` +
        "Refusing to overwrite or continue a split release."
      );
    }
    process.stdout.write(
      `${packageEntry.name}@${packageEntry.version} already matches the validated artifact; skipping.\n`
    );
    return;
  }

  const tarball = resolve(artifacts, packageEntry.filename);
  await run("npm", [
    "publish",
    tarball,
    "--access",
    "public",
    "--tag",
    npmDistTag,
    "--registry",
    NPM_REGISTRY_URL,
    "--provenance"
  ]);

  const publishedIntegrity = await waitForRegistryIntegrity(
    packageEntry.name,
    packageEntry.version
  );
  if (publishedIntegrity !== packageEntry.integrity) {
    throw new Error(
      `${packageEntry.name}@${packageEntry.version} was published with an unexpected integrity value.`
    );
  }
  process.stdout.write(`Published ${packageEntry.name}@${packageEntry.version}.\n`);
}

async function publishDryRun(artifacts, packageEntry, npmDistTag) {
  // --force only bypasses npm 11's existing-version check in dry-run mode.
  // publishOrVerifyExisting deliberately never passes it.
  await run("npm", [
    "publish",
    resolve(artifacts, packageEntry.filename),
    "--dry-run",
    "--force",
    "--access",
    "public",
    "--tag",
    npmDistTag,
    "--registry",
    NPM_REGISTRY_URL,
    "--provenance=false"
  ]);
}

export async function readRegistryIntegrity(name, version) {
  const result = await run(
    "npm",
    [
      "view",
      `${name}@${version}`,
      "dist.integrity",
      "--json",
      "--registry",
      NPM_REGISTRY_URL
    ],
    { allowFailure: true }
  );
  return parseRegistryIntegrityResult(result, name, version);
}

export function parseRegistryIntegrityResult(result, name, version) {
  if (result.code === 0) {
    const output = (result.stdout || "").trim();
    if (!output) return null;

    let value;
    try {
      value = JSON.parse(output);
    } catch (error) {
      throw new Error(
        `Registry returned malformed integrity metadata for ${name}@${version}.`,
        { cause: error }
      );
    }
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !value.startsWith("sha512-")) {
      throw new Error(`Registry returned invalid integrity metadata for ${name}@${version}.`);
    }
    return value;
  }

  const failure = `${result.stderr}\n${result.stdout}`;
  if (/\bE404\b|404 Not Found/i.test(failure)) return null;
  throw new Error(
    `Could not inspect ${name}@${version} before publishing.\n${failure.trim().slice(-4000)}`
  );
}

export function isRetryableRegistryFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EPIPE|ETIMEDOUT)\b|\bE(?:408|425|429|500|502|503|504)\b|\b(?:HTTP|status(?: code)?)\s*:?[ ]*(?:408|425|429|500|502|503|504)\b|\b(?:408 Request Timeout|425 Too Early|429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b|socket hang up|network timeout/i.test(
    message
  );
}

async function waitForRegistryIntegrity(name, version) {
  let lastTransientError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const integrity = await readRegistryIntegrity(name, version);
      if (integrity) return integrity;
    } catch (error) {
      if (!isRetryableRegistryFailure(error)) throw error;
      lastTransientError = error;
    }
    if (attempt < 11) await delay(5000);
  }

  const suffix = lastTransientError
    ? ` Last transient registry error: ${lastTransientError.message}`
    : "";
  throw new Error(
    `Timed out waiting for ${name}@${version} to become visible in the registry.${suffix}`,
    lastTransientError ? { cause: lastTransientError } : undefined
  );
}

function parseArgs(args) {
  const options = { artifacts: "", tag: "", dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifacts") {
      options.artifacts = requireValue(args, ++index, arg);
    } else if (arg === "--tag") {
      options.tag = requireValue(args, ++index, arg);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.artifacts) throw new Error("--artifacts is required.");
  if (!options.tag) throw new Error("--tag is required.");
  options.artifacts = resolve(options.artifacts);
  return options;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/release/publish.mjs --artifacts <directory> --tag <vX.Y.Z> [--dry-run]\n`);
}
