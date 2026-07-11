import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { PublicRunOperations } from "../http/public-schemas.ts";
import { registerPublicRunTools } from "./tools.ts";

export function createPublicMcpServer(dependencies: {
  actor: MemberActor;
  runs: PublicRunOperations;
}): McpServer {
  const server = new McpServer({ name: "2collab", version: "0.1.0" });
  registerPublicRunTools(server, dependencies);
  return server;
}
