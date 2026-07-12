import type { Context } from "hono";
import type { Result } from "../../../shared/contracts/result.ts";

type DomainHttpStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

const DomainHttpStatuses: Readonly<Record<string, DomainHttpStatus>> = {
  ACTOR_NOT_AUTHORIZED: 403,
  AUTH_MODE_CONFLICT: 401,
  AUTHORITY_FACT_UNAVAILABLE: 503,
  AUTHORITY_STALE: 409,
  COMMAND_INVALID: 400,
  DEVICE_ACCESS_INVALID: 401,
  DEVICE_AUTHENTICATION_REQUIRED: 401,
  DPOP_INVALID: 401,
  DPOP_REPLAY: 401,
  IDEMPOTENCY_CONFLICT: 409,
  PROJECT_NOT_FOUND: 404,
  QUERY_INVALID: 400,
  RATE_LIMITED: 429,
  RUN_LAUNCH_STORAGE_FAILED: 500,
  RUN_NOT_FOUND: 404,
  RUN_REVISION_CONFLICT: 409,
  RUN_TERMINAL: 409,
  RUNNER_MAPPING_CONFLICT: 409,
  RUNNER_MAPPING_FAILED: 500,
  RUNNER_MAPPING_STALE: 409,
  RUNNER_OWNER_REQUIRED: 403,
  RUNNER_PROFILE_FAILED: 500,
  RUNNER_PROFILE_STALE: 409,
  SESSION_INVALID: 401,
  SESSION_REQUIRED: 401,
};

export function domainHttpStatus(code: string): DomainHttpStatus {
  return DomainHttpStatuses[code] ?? 400;
}

export function encodeDomainResult<T>(
  context: Context,
  result: Result<T>,
  successStatus: 200 | 201 = 200,
): Response {
  return result.ok
    ? context.json(result, successStatus)
    : context.json(result, domainHttpStatus(result.error.code));
}
