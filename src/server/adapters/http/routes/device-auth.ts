import { Hono } from "hono";
import { z } from "zod";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { PublicAuthenticationPort } from "../middleware/authentication.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";

const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Secret = z.string().min(32).max(512);
const BeginSchema = z
  .object({ idempotencyKey: Identifier, deviceId: Identifier, senderKeyThumbprint: Identifier })
  .strict();
const ApproveSchema = z.object({ idempotencyKey: Identifier }).strict();
const ExchangeSchema = z
  .object({ idempotencyKey: Identifier, deviceCode: Secret, senderKeyThumbprint: Identifier })
  .strict();
const RefreshSchema = z
  .object({
    idempotencyKey: Identifier,
    refreshCredential: Secret,
    senderKeyThumbprint: Identifier,
  })
  .strict();

type DeviceAuthority = Readonly<{
  begin(input: z.infer<typeof BeginSchema>): Promise<Result<unknown>>;
  approve(
    input: Readonly<{
      idempotencyKey: string;
      actor: MemberActor;
      deviceCodeId: string;
    }>,
  ): Promise<Result<unknown>>;
  exchange(input: z.infer<typeof ExchangeSchema>): Promise<Result<unknown>>;
  refresh(input: z.infer<typeof RefreshSchema>): Promise<Result<unknown>>;
}>;

function status(result: Result<unknown>): 200 | 400 | 401 | 403 | 409 {
  if (result.ok) return 200;
  if (result.error.code.includes("AUTHORITY") || result.error.code.includes("SESSION")) return 401;
  if (result.error.code.includes("CONFLICT") || result.error.code.includes("REPLAY")) return 409;
  return 400;
}

export function createDeviceAuthRoutes(
  dependencies: Readonly<{
    authority: DeviceAuthority;
    authentication: PublicAuthenticationPort;
  }>,
): Hono {
  const app = new Hono();

  app.post("/authorization", async (context) => {
    const input = await parseBoundedJson(context, BeginSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.authority.begin(input);
    return context.json(result, status(result));
  });

  app.post("/authorization/:deviceCodeId/approve", async (context) => {
    const actor = await dependencies.authentication.authenticateBrowser(context.req.raw);
    if (!actor.ok) return context.json(actor, 401);
    if (!dependencies.authentication.verifyBrowserMutation(context.req.raw, actor.value))
      return context.json(
        { error: { code: "CSRF_INVALID", message: "The browser mutation proof is invalid." } },
        403,
      );
    const input = await parseBoundedJson(context, ApproveSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.authority.approve({
      ...input,
      actor: actor.value,
      deviceCodeId: context.req.param("deviceCodeId"),
    });
    return context.json(result, status(result));
  });

  app.post("/token", async (context) => {
    const input = await parseBoundedJson(context, ExchangeSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.authority.exchange(input);
    return context.json(result, status(result));
  });

  app.post("/refresh", async (context) => {
    const input = await parseBoundedJson(context, RefreshSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.authority.refresh(input);
    return context.json(result, status(result));
  });

  return app;
}
