import { z } from "zod";
import type { TemplateBindingOperations } from "../server/modules/templates/bindings.ts";
import type { WorkflowAuthoringOperations } from "../server/modules/workflows/authoring.ts";
import { type ProjectView, ProjectViewSchema } from "../shared/contracts/projects.ts";
import {
  type PublicRunClient,
  PublicRunOperationResultSchema,
  type PublicRunResult,
} from "../shared/contracts/public-api.ts";
import { DomainErrorSchema, type Result } from "../shared/contracts/result.ts";
import {
  type ProjectIdentityRequest,
  ProjectIdentityRequestSchema,
  ProjectListRequestSchema,
  type ProjectsApi,
} from "./ports/projects-api.ts";

type ResultOf<K extends PublicRunResult["kind"]> = Result<Extract<PublicRunResult, { kind: K }>>;

export type { PublicRunClient } from "../shared/contracts/public-api.ts";

export interface DeviceCredentialProvider {
  headers(input: Readonly<{ method: "GET" | "POST"; url: string }>): Promise<HeadersInit>;
}

type Dependencies = Readonly<{
  baseUrl: string;
  credentials: DeviceCredentialProvider;
  fetch?: typeof fetch;
}>;

const MAX_RESPONSE_BYTES = 256 * 1024;

function unavailable(): Result<never> {
  return {
    ok: false,
    error: { code: "API_UNAVAILABLE", message: "The Collab API is unavailable.", retry: "REFRESH" },
  };
}

export function createPublicApiClient(dependencies: Dependencies): PublicRunClient {
  const request = async <K extends PublicRunResult["kind"]>(
    method: "GET" | "POST",
    path: string,
    expectedKind: K,
    body?: unknown,
  ): Promise<ResultOf<K>> => {
    const url = new URL(path, dependencies.baseUrl).toString();
    try {
      const credentialHeaders = await dependencies.credentials.headers({ method, url });
      const response = await (dependencies.fetch ?? fetch)(url, {
        method,
        headers: {
          ...Object.fromEntries(new Headers(credentialHeaders)),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return unavailable();
      const parsed = PublicRunOperationResultSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return unavailable();
      if (!parsed.data.ok) return parsed.data as ResultOf<K>;
      return parsed.data.value.kind === expectedKind ? (parsed.data as ResultOf<K>) : unavailable();
    } catch {
      return unavailable();
    }
  };

  return {
    create: (input) => request("POST", "/api/v1/runs", "CREATE_RUN", input),
    inspect: (input) => request("GET", `/api/v1/runs/${input.runId}`, "INSPECT_RUN"),
    cancel: (input) => request("POST", `/api/v1/runs/${input.runId}/cancel`, "CANCEL_RUN", input),
    resume: (input) => request("POST", `/api/v1/runs/${input.runId}/resume`, "RESUME_RUN", input),
    evidence: (input) => {
      const query = new URLSearchParams({ limit: String(input.limit) });
      if (input.after) query.set("after", input.after);
      return request("GET", `/api/v1/runs/${input.runId}/evidence?${query}`, "INSPECT_EVIDENCE");
    },
  };
}

type ProjectsApiDependencies = Readonly<{
  credentials: DeviceCredentialProvider;
  fetch?: typeof fetch;
}>;

const ProjectResultSchema = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), value: ProjectViewSchema, auditId: z.string().optional() })
    .strict(),
  z
    .object({ ok: z.literal(false), error: DomainErrorSchema, auditId: z.string().optional() })
    .strict(),
]);

const ProjectListResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      value: z.array(ProjectViewSchema),
      auditId: z.string().optional(),
    })
    .strict(),
  z
    .object({ ok: z.literal(false), error: DomainErrorSchema, auditId: z.string().optional() })
    .strict(),
]);

export function createProjectsApiClient(dependencies: ProjectsApiDependencies): ProjectsApi {
  const request = async (
    method: "GET",
    serverOrigin: string,
    path: string,
    resultSchema: typeof ProjectResultSchema | typeof ProjectListResultSchema,
  ): Promise<Result<ProjectView> | Result<readonly ProjectView[]>> => {
    const url = new URL(path, serverOrigin).toString();
    try {
      const credentialHeaders = await dependencies.credentials.headers({ method, url });
      const response = await (dependencies.fetch ?? fetch)(url, {
        method,
        headers: { ...Object.fromEntries(new Headers(credentialHeaders)) },
        redirect: "error",
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return unavailable();
      const parsed = resultSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return unavailable();
      if (!parsed.data.ok)
        return parsed.data as Result<ProjectView> | Result<readonly ProjectView[]>;
      return parsed.data as Result<ProjectView> | Result<readonly ProjectView[]>;
    } catch {
      return unavailable();
    }
  };

  return {
    inspect: async (input: ProjectIdentityRequest) => {
      const parsed = ProjectIdentityRequestSchema.safeParse(input);
      if (!parsed.success) return unavailable();
      return request(
        "GET",
        parsed.data.serverOrigin,
        `/api/v1/projects/${encodeURIComponent(parsed.data.projectId)}`,
        ProjectResultSchema,
      ) as Promise<Result<ProjectView>>;
    },
    list: async (input) => {
      const parsed = ProjectListRequestSchema.safeParse(input);
      if (!parsed.success) return unavailable();
      return request(
        "GET",
        parsed.data.serverOrigin,
        "/api/v1/projects",
        ProjectListResultSchema,
      ) as Promise<Result<readonly ProjectView[]>>;
    },
  };
}

const AutomationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: DomainErrorSchema }).strict(),
]);

export function createAutomationApiClient(dependencies: Dependencies): Readonly<{
  workflows: WorkflowAuthoringOperations;
  templates: TemplateBindingOperations;
}> {
  const post = async (path: string, body: unknown) => {
    const url = new URL(path, dependencies.baseUrl).toString();
    try {
      const credentialHeaders = await dependencies.credentials.headers({ method: "POST", url });
      const response = await (dependencies.fetch ?? fetch)(url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(new Headers(credentialHeaders)),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return unavailable();
      const parsed = AutomationResultSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : unavailable();
    } catch {
      return unavailable();
    }
  };
  return {
    workflows: {
      save: (command) =>
        post(`/api/v1/workflow-drafts/${encodeURIComponent(command.draftId)}`, command) as never,
    },
    templates: { bind: (command) => post("/api/v1/workflow-presets/bind", command) },
  };
}
