import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PublicCancelRunRequestSchema,
  PublicCreateRunRequestSchema,
  PublicInspectEvidenceRequestSchema,
  PublicInspectRunRequestSchema,
  PublicResumeRunRequestSchema,
  type PublicRunClient,
  PublicRunOperationResultSchema,
  PublicRunResultSchema,
} from "../../../shared/contracts/public-api.ts";
import { DomainErrorSchema } from "../../../shared/contracts/result.ts";
import type { PublicRunOperations } from "../../modules/public-surface/contract.ts";

type Dependencies = Readonly<{ runs: PublicRunClient }>;

// SDK 1.29.0's output validation normalizes an object schema before parsing.
// Keep the published tool output schema object-shaped while the callback below
// enforces the stricter discriminated public result contract.
const PublicRunToolOutputSchema = z
  .object({
    ok: z.boolean(),
    value: PublicRunResultSchema.optional(),
    error: DomainErrorSchema.optional(),
  })
  .strict();

function toolResult(result: unknown) {
  const parsed = PublicRunOperationResultSchema.parse(result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(parsed) }],
    structuredContent: parsed,
    ...(parsed.ok ? {} : { isError: true }),
  };
}

export function registerPublicRunTools(server: McpServer, dependencies: Dependencies): void {
  server.registerTool(
    "collab_run_create",
    {
      title: "Create Agent Run",
      description: "Create one Agent Run from a public preset selection.",
      inputSchema: PublicCreateRunRequestSchema,
      outputSchema: PublicRunToolOutputSchema,
    },
    async (request) => toolResult(await dependencies.runs.create(request)),
  );
  server.registerTool(
    "collab_run_inspect",
    {
      title: "Inspect Agent Run",
      description: "Inspect one Agent Run.",
      inputSchema: PublicInspectRunRequestSchema,
      outputSchema: PublicRunToolOutputSchema,
    },
    async (request) => toolResult(await dependencies.runs.inspect(request)),
  );
  server.registerTool(
    "collab_run_cancel",
    {
      title: "Cancel Agent Run",
      description: "Cancel one Agent Run with revision compare-and-swap.",
      inputSchema: PublicCancelRunRequestSchema,
      outputSchema: PublicRunToolOutputSchema,
    },
    async (request) => toolResult(await dependencies.runs.cancel(request)),
  );
  server.registerTool(
    "collab_run_resume",
    {
      title: "Resume Agent Run",
      description: "Resume one Agent Run from a durable checkpoint.",
      inputSchema: PublicResumeRunRequestSchema,
      outputSchema: PublicRunToolOutputSchema,
    },
    async (request) => toolResult(await dependencies.runs.resume(request)),
  );
  server.registerTool(
    "collab_run_evidence",
    {
      title: "Inspect Agent Run Evidence",
      description: "Inspect a bounded page of Agent Run evidence.",
      inputSchema: PublicInspectEvidenceRequestSchema,
      outputSchema: PublicRunToolOutputSchema,
    },
    async (request) => toolResult(await dependencies.runs.evidence(request)),
  );
}

export function bindPublicRunOperations(
  actor: import("../../../shared/contracts/actors.ts").MemberActor,
  operations: PublicRunOperations,
): PublicRunClient {
  return {
    create: (request) => operations.create(actor, request),
    inspect: (request) => operations.inspect(actor, request),
    cancel: (request) => operations.cancel(actor, request),
    resume: (request) => operations.resume(actor, request),
    evidence: (request) => operations.evidence(actor, request),
  };
}
