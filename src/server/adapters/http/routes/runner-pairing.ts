import { Hono } from "hono";
import { z } from "zod";
import type {
  RunnerAuthenticationAuthority,
  RunnerRegistry,
} from "../../../modules/runners/contract.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { PublicAuthenticationPort } from "../middleware/authentication.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";

const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const BeginSchema = z.object({ idempotencyKey: Identifier }).strict();
const ConfirmSchema = BeginSchema;
const ConsumeSchema = z
  .object({
    idempotencyKey: Identifier,
    pairingSecret: z.string().min(32).max(512),
    keyId: Identifier,
    keyProof: z.string().min(1).max(8_192),
  })
  .strict();
const TokenSchema = z
  .object({
    runnerCredential: z.string().min(32).max(512),
    keyProof: z.string().min(1).max(8_192),
  })
  .strict();

function status(result: Result<unknown>): 200 | 400 | 401 | 403 | 409 {
  if (result.ok) return 200;
  if (result.error.code.includes("SESSION") || result.error.code.includes("AUTHENTICATION"))
    return 401;
  if (result.error.code.includes("OWNER") || result.error.code.includes("MEMBER_MISMATCH"))
    return 403;
  if (result.error.code.includes("CONSUMED") || result.error.code.includes("REPLAY")) return 409;
  return 400;
}

export function createRunnerPairingRoutes(
  dependencies: Readonly<{
    registry: Pick<RunnerRegistry, "beginPairing" | "confirmPairing" | "consumePairing">;
    runnerAuthentication?: Pick<RunnerAuthenticationAuthority, "exchangeCredential">;
    authentication: PublicAuthenticationPort;
  }>,
): Hono {
  const app = new Hono();

  app.post("/begin", async (context) => {
    if (!dependencies.authentication.authenticateRunnerDevice) {
      return context.json(
        {
          ok: false,
          error: {
            code: "DEVICE_AUTHENTICATION_REQUIRED",
            message: "Device authentication is required.",
            retry: "NEVER",
          },
        },
        401,
      );
    }
    const principal = await dependencies.authentication.authenticateRunnerDevice(context.req.raw);
    if (!principal.ok) return context.json(principal, 401);
    const input = await parseBoundedJson(context, BeginSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.registry.beginPairing({
      ...input,
      principal: principal.value,
    });
    return context.json(result, status(result));
  });

  app.post("/:pairingId/confirm", async (context) => {
    const actor = await dependencies.authentication.authenticateBrowser(context.req.raw);
    if (!actor.ok) return context.json(actor, 401);
    if (!dependencies.authentication.verifyBrowserMutation(context.req.raw, actor.value)) {
      return context.json(
        {
          ok: false,
          error: {
            code: "CSRF_INVALID",
            message: "The browser mutation proof is invalid.",
            retry: "NEVER",
          },
        },
        403,
      );
    }
    const input = await parseBoundedJson(context, ConfirmSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.registry.confirmPairing({
      ...input,
      actor: actor.value,
      pairingId: context.req.param("pairingId"),
    });
    return context.json(result, status(result));
  });

  app.post("/consume", async (context) => {
    const input = await parseBoundedJson(context, ConsumeSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.registry.consumePairing(input);
    return context.json(result, status(result));
  });
  app.post("/token", async (context) => {
    if (!dependencies.runnerAuthentication) {
      return context.json(
        {
          ok: false,
          error: {
            code: "RUNNER_AUTHENTICATION_UNAVAILABLE",
            message: "Runner authentication is unavailable.",
            retry: "REFRESH",
          },
        },
        503,
      );
    }
    const input = await parseBoundedJson(context, TokenSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.runnerAuthentication.exchangeCredential(input);
    return context.json(result, result.ok ? 200 : 401);
  });
  return app;
}
