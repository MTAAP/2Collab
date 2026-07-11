import type { Context } from "hono";
import type { z } from "zod";

const MAX_BODY_BYTES = 64 * 1024;

export async function parseBoundedJson<S extends z.ZodType>(
  context: Context,
  schema: S,
): Promise<z.infer<S> | Response> {
  if (context.req.header("content-type") !== "application/json") {
    return context.json(
      { error: { code: "JSON_REQUIRED", message: "A JSON request body is required." } },
      415,
    );
  }
  const declaredLength = Number(context.req.header("content-length") ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) {
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
