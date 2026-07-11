#!/usr/bin/env bun

import { runCli } from "./command.ts";
import { startStdioMcpBridge } from "./commands/mcp.ts";
import { createTestRunClientFromEnvironment } from "./credentials.ts";

const runsApi = createTestRunClientFromEnvironment(Bun.env);
process.exitCode = await runCli(Bun.argv.slice(2), undefined, {
  environment: Bun.env,
  runtimeVersion: Bun.version,
  cwd: process.cwd(),
  runsApi,
  mcpBridge: runsApi ? () => startStdioMcpBridge(runsApi) : undefined,
});
