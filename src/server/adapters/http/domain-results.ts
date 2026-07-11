import type { Context } from "hono";
import type { Result } from "../../../shared/contracts/result.ts";

function statusFor(code: string): 400 | 401 | 403 | 404 | 409 | 429 | 500 {
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("CONFLICT") || code.includes("STALE") || code.includes("TERMINAL")) return 409;
  if (code.includes("SESSION") || code.includes("AUTHENTICATION")) return 401;
  if (code.includes("DENIED") || code.includes("FORBIDDEN")) return 403;
  if (code.includes("RATE")) return 429;
  if (code.includes("STORAGE") || code.includes("INTERNAL")) return 500;
  return 400;
}

export function encodeDomainResult<T>(context: Context, result: Result<T>): Response {
  return result.ok ? context.json(result, 200) : context.json(result, statusFor(result.error.code));
}
