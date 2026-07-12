#!/usr/bin/env bun

import { runCli } from "./command.ts";
import { createCliDependencies } from "./dependencies.ts";

const dependencies = createCliDependencies(Bun.env, {
  cwd: process.cwd(),
  runtimeVersion: Bun.version,
});
process.exitCode = await runCli(Bun.argv.slice(2), undefined, dependencies);
