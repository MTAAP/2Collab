import { createHash, timingSafeEqual } from "node:crypto";

export type SameOriginMutation = Readonly<{
  origin: string | null;
  method: string;
  contentType: string | null;
  configuredOrigin: string;
}>;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_CONTENT_TYPES = new Set(["application/json", "application/cbor"]);

export function verifyCsrf(
  sessionCsrfHash: Uint8Array,
  headerToken: string,
  request: SameOriginMutation,
): boolean {
  if (
    headerToken.length < 32 ||
    headerToken.length > 512 ||
    request.origin !== request.configuredOrigin ||
    !MUTATION_METHODS.has(request.method.toUpperCase())
  ) {
    return false;
  }
  const mediaType = request.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || !SAFE_CONTENT_TYPES.has(mediaType)) return false;
  const right = createHash("sha256").update(headerToken, "utf8").digest();
  return sessionCsrfHash.length === right.length && timingSafeEqual(sessionCsrfHash, right);
}
