#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildArtifactSet,
  compareArtifactDirectories,
  verifyArtifactDirectory
} from "./lib.mjs";

let temporaryOutput = "";
let reproductionOutput = "";

try {
  const options = parseArgs(process.argv.slice(2));
  const output = options.output || await createTemporaryOutput();
  if (!options.output) temporaryOutput = output;

  const metadata = await buildArtifactSet(output, {
    tag: options.tag,
    requireClean: options.requireClean,
    installSmoke: true,
    publishDryRun: true
  });

  if (options.verifyReproducible) {
    reproductionOutput = await createTemporaryOutput();
    await buildArtifactSet(reproductionOutput, {
      tag: options.tag,
      requireClean: false,
      installSmoke: false,
      publishDryRun: false
    });
    await compareArtifactDirectories(output, reproductionOutput);
  }

  await verifyArtifactDirectory(output, { expectedTag: options.tag });
  process.stdout.write([
    `Release ${metadata.tag} validated.`,
    `Artifacts: ${output}`,
    `npm dist-tag: ${metadata.npmDistTag}`,
    `Reproducible: ${options.verifyReproducible ? "yes" : "not checked"}`,
    "Global install smoke: passed",
    "npm publish dry-runs: passed",
    ""
  ].join("\n"));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryOutput) await rm(temporaryOutput, { recursive: true, force: true });
  if (reproductionOutput) await rm(reproductionOutput, { recursive: true, force: true });
}

function parseArgs(args) {
  const options = {
    output: "",
    tag: "",
    requireClean: false,
    verifyReproducible: true
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      options.output = requireValue(args, ++index, arg);
    } else if (arg === "--tag") {
      options.tag = requireValue(args, ++index, arg);
    } else if (arg === "--require-clean") {
      options.requireClean = true;
    } else if (arg === "--no-reproducibility-check") {
      options.verifyReproducible = false;
    } else if (arg === "--check") {
      // The default without --output already builds into a temporary directory.
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.output) options.output = resolve(options.output);
  return options;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

async function createTemporaryOutput() {
  return mkdtemp(`${tmpdir()}/privacyai-release-`);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/release/build.mjs [options]\n\nOptions:\n  --output <directory>          Keep validated release artifacts in an empty directory\n  --tag <vX.Y.Z>               Require the package version to match a release tag\n  --require-clean              Reject a dirty Git checkout\n  --no-reproducibility-check   Skip the second byte-for-byte build\n  --check                      Build and validate in a temporary directory (default)\n`);
}
