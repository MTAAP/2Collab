import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPublicRunTools } from "../../server/adapters/mcp/tools.ts";
import type { PublicRunClient } from "../api-client.ts";

export async function startStdioMcpBridge(
  runs: PublicRunClient,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const server = new McpServer({ name: "2collab-stdio", version: "0.1.0" });
  registerPublicRunTools(server, { runs });
  await server.connect(new StdioServerTransport(input, output));
}
