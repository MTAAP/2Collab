import { PublicCreateRunRequestSchema } from "../../shared/contracts/public-api.ts";
import type { PublicRunClient } from "../api-client.ts";

export type StartCommandOutput = Readonly<{
  json: boolean;
  result: Awaited<ReturnType<PublicRunClient["create"]>>;
}>;

function values(args: readonly string[]): Map<string, string> | null {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--json") {
      if (parsed.has(key)) return null;
      parsed.set(key, "true");
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || parsed.has(key)) return null;
    parsed.set(key, value);
    index += 1;
  }
  return parsed;
}

export async function startRun(
  args: readonly string[],
  client: PublicRunClient,
): Promise<StartCommandOutput> {
  const input = values(args);
  if (!input) throw new Error("RUN_ARGUMENTS_INVALID");
  const presetVersion = Number(input.get("--preset-version"));
  const request = PublicCreateRunRequestSchema.safeParse({
    idempotencyKey: input.get("--idempotency-key"),
    projectId: input.get("--project"),
    coordination: {
      kind: "NEW",
      title: input.get("--record-title"),
      sourceRefs: [],
    },
    goal: input.get("--goal"),
    repository: { repositoryId: input.get("--repository") },
    preset: { presetId: input.get("--preset"), presetVersion },
  });
  if (!request.success) throw new Error("RUN_ARGUMENTS_INVALID");
  const allowed = new Set([
    "--project",
    "--preset",
    "--preset-version",
    "--goal",
    "--repository",
    "--record-title",
    "--idempotency-key",
    "--json",
  ]);
  if ([...input.keys()].some((key) => !allowed.has(key))) throw new Error("RUN_ARGUMENTS_INVALID");
  return { json: input.has("--json"), result: await client.create(request.data) };
}
