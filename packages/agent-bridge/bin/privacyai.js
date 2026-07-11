#!/usr/bin/env node
import { runPrivacyAiCli } from "../src/cli.js";

process.exitCode = await runPrivacyAiCli();
