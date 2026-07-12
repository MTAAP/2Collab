import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { QueryResult } from "../../../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { PersonalWorkflowPreset } from "../../../shared/contracts/templates.ts";

export type ResolvedWorkflowBindings = Extract<
  QueryResult,
  { kind: "RESOLVE_PERSONAL_RUN_PRESET_BINDINGS" }
>["bindings"];

function failure(): Result<never> {
  return {
    ok: false,
    error: {
      code: "PRESET_BINDING_REQUIRED",
      message: "A missing or stale workflow binding requires an explicit replacement.",
      retry: "EXPLICIT_RESUME",
    },
  };
}

export async function resolveWorkflowBindings(
  preset: PersonalWorkflowPreset,
  actor: MemberActor,
  authority: ExecutionAuthority,
): Promise<Result<ResolvedWorkflowBindings>> {
  if (actor.memberId !== preset.ownerMemberId) return failure();
  const resolved = await authority.query({
    kind: "RESOLVE_PERSONAL_RUN_PRESET_BINDINGS",
    actor,
    bindings: preset.bindings,
  });
  if (!resolved.ok || resolved.value.staleKeys.length > 0) return failure();
  const expectedKeys = Object.keys(preset.bindings).sort();
  if (Object.keys(resolved.value.bindings).sort().join("\0") !== expectedKeys.join("\0"))
    return failure();
  return { ok: true, value: resolved.value.bindings };
}

export type TemplateBindingOperations = Readonly<{
  bind(command: unknown): Promise<Result<unknown>>;
}>;
