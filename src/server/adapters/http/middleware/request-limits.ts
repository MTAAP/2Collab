import type { Context } from "hono";
import type { z } from "zod";

const MAX_BODY_BYTES = 64 * 1024;
const JsonContentType = /^application\/json(?:;\s*charset=utf-8)?$/i;

export interface PublicRateLimitPort {
  allow(input: Readonly<{ actorId: string; method: string; path: string }>): boolean;
}

export async function parseBoundedJson<S extends z.ZodType>(
  context: Context,
  schema: S,
): Promise<z.infer<S> | Response> {
  if (!JsonContentType.test(context.req.header("content-type") ?? "")) {
    return context.json(
      { error: { code: "JSON_REQUIRED", message: "A JSON request body is required." } },
      415,
    );
  }
  const declared = context.req.header("content-length");
  if (declared !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(declared)) {
    return context.json(
      { error: { code: "CONTENT_LENGTH_INVALID", message: "Content-Length is invalid." } },
      400,
    );
  }
  const declaredLength = declared === undefined ? 0 : Number(declared);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_BODY_BYTES) {
    return context.json(
      { error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } },
      413,
    );
  }
  const text = await context.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return context.json(
      { error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } },
      413,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return context.json(
      { error: { code: "JSON_INVALID", message: "The JSON request body is invalid." } },
      400,
    );
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? parsed.data
    : context.json({ error: { code: "REQUEST_INVALID", message: "The request is invalid." } }, 400);
}

export function enforceRateLimit(
  context: Context,
  rateLimits: PublicRateLimitPort,
  actorId: string,
): Response | undefined {
  return rateLimits.allow({
    actorId,
    method: context.req.method,
    path: new URL(context.req.url).pathname,
  })
    ? undefined
    : context.json(
        { error: { code: "RATE_LIMITED", message: "Request rate limit exceeded." } },
        429,
      );
}
