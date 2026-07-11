import {
  type PublicRunClient,
  PublicRunOperationResultSchema,
  type PublicRunResult,
} from "../shared/contracts/public-api.ts";
import type { Result } from "../shared/contracts/result.ts";

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
