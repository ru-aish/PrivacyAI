#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { runPrivacyAiCli } from "../src/cli.js";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);

process.exitCode = await runPrivacyAiCli(process.argv.slice(2), {
  version: manifest.version
});
