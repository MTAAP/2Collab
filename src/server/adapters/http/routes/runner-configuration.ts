import { Hono, type Context } from "hono";
import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "../../../../shared/contracts/ids.ts";
import type { RunnerRegistry } from "../../../modules/runners/contract.ts";
import { encodeDomainResult } from "../domain-results.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import {
  enforceRateLimit,
  type PublicRateLimitPort,
  parseBoundedJson,
} from "../middleware/request-limits.ts";

const PositiveRevisionSchema = z.number().int().positive();
const MappingMutationSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    projectId: IdentifierSchema,
    localMappingId: IdentifierSchema,
    expectedRevision: PositiveRevisionSchema.optional(),
  })
  .strict();
const ProfileMutationSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    profileId: IdentifierSchema.optional(),
    expectedVersion: PositiveRevisionSchema.optional(),
    displayName: z.string().trim().min(1).max(120),
    adapter: z.enum(["CLAUDE", "CODEX", "PI", "OPENCODE"]),
    hosts: z
      .array(z.enum(["NATIVE", "ORCA"]))
      .min(1)
      .max(2),
    interactions: z
      .array(z.enum(["HEADLESS", "INTERACTIVE"]))
      .min(1)
      .max(2),
    riskSummary: z.string().trim().min(1).max(240),
    fingerprint: Sha256Schema,
  })
  .strict()
  .refine((value) => new Set(value.hosts).size === value.hosts.length)
  .refine((value) => new Set(value.interactions).size === value.interactions.length)
  .refine((value) => (value.profileId === undefined) === (value.expectedVersion === undefined));

type Dependencies = Readonly<{
  configuredOrigin: string;
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  registry: Pick<RunnerRegistry, "registerMapping" | "replaceMapping" | "advertiseProfile">;
}>;

async function authorizeMutation(context: Context, dependencies: Dependencies) {
  const authenticated = await authenticatePublicRequest(
    context.req.raw,
    dependencies.authentication,
  );
  if (!authenticated.ok) return context.json(authenticated, 401);
  const limited = enforceRateLimit(
    context,
    dependencies.rateLimits,
    authenticated.value.actor.memberId,
  );
  if (limited) return limited;
  if (
    authenticated.value.browser &&
    (context.req.header("origin") !== dependencies.configuredOrigin ||
      !dependencies.authentication.verifyBrowserMutation(
        context.req.raw,
        authenticated.value.actor,
      ))
  ) {
    return context.json(
      { error: { code: "CSRF_INVALID", message: "CSRF proof is invalid." } },
      403,
    );
  }
  return authenticated.value.actor;
}

export function createRunnerConfigurationRoutes(dependencies: Dependencies): Hono {
  const app = new Hono();

  app.post("/:runnerId/mappings", async (context) => {
    const actor = await authorizeMutation(context, dependencies);
    if (actor instanceof Response) return actor;
    const body = await parseBoundedJson(context, MappingMutationSchema);
    if (body instanceof Response) return body;
    const command = {
      actor,
      idempotencyKey: body.idempotencyKey,
      runnerId: context.req.param("runnerId") as never,
      projectId: body.projectId as never,
      localMappingId: body.localMappingId,
    };
    const result =
      body.expectedRevision === undefined
        ? await dependencies.registry.registerMapping(command)
        : await dependencies.registry.replaceMapping({
            ...command,
            expectedRevision: body.expectedRevision,
          });
    return encodeDomainResult(context, result, body.expectedRevision === undefined ? 201 : 200);
  });

  app.post("/:runnerId/profiles", async (context) => {
    const actor = await authorizeMutation(context, dependencies);
    if (actor instanceof Response) return actor;
    const body = await parseBoundedJson(context, ProfileMutationSchema);
    if (body instanceof Response) return body;
    const result = await dependencies.registry.advertiseProfile({
      ...body,
      actor,
      runnerId: context.req.param("runnerId") as never,
      profileId: body.profileId as never,
    });
    return encodeDomainResult(context, result, body.expectedVersion === undefined ? 201 : 200);
  });

  return app;
}
