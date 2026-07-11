import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { PublicRunOperations } from "../../modules/public-surface/contract.ts";
import { bindPublicRunOperations, registerPublicRunTools } from "./tools.ts";
import { registerOutlineTools } from "./outline-tools.ts";

export function createPublicMcpServer(dependencies: {
  actor: MemberActor;
  runs: PublicRunOperations;
  outline?: Readonly<{
    search(actor: MemberActor, input: unknown): Promise<unknown>;
    read(actor: MemberActor, input: unknown): Promise<unknown>;
  }>;
}): McpServer {
  const server = new McpServer({ name: "2collab", version: "0.1.0" });
  registerPublicRunTools(server, {
    runs: bindPublicRunOperations(dependencies.actor, dependencies.runs),
  });
  if (dependencies.outline) registerOutlineTools(server, dependencies.actor, dependencies.outline);
  return server;
}
