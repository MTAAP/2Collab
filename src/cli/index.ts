#!/usr/bin/env bun

import { runCli } from "./command.ts";

process.exitCode = await runCli(Bun.argv.slice(2));
