import { z } from "zod";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export async function browserJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const csrf = sessionStorage.getItem("collab_csrf");
  if (csrf) headers.set("x-collab-csrf", csrf);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    redirect: "error",
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(json);
    throw new Error(parsed.success ? parsed.data.error.code : "REQUEST_FAILED");
  }
  return schema.parse(json);
}
