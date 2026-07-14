import { createHmac, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import type { Result } from "../../../shared/contracts/result.ts";
import { error } from "./policy.ts";
import type { DispatchPermitClaims, PermitCodec } from "./execution-authority.ts";

const JWT_HEADER = JSON.stringify({ alg: "HS256", typ: "JWT" });
const HEX_SECRET_PATTERN = /^[0-9a-fA-F]{64}$/;

export function createHmacPermitCodec(deploymentMasterKey: Uint8Array): PermitCodec {
  return {
    async sign(claims: DispatchPermitClaims): Promise<string> {
      const encodedHeader = Buffer.from(JWT_HEADER).toString("base64url");
      const encodedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const signature = createHmac("sha256", deploymentMasterKey).update(signingInput).digest();
      const encodedSignature = Buffer.from(signature).toString("base64url");
      return `${signingInput}.${encodedSignature}`;
    },

    async verify(token: string): Promise<Result<DispatchPermitClaims>> {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      const encodedHeader = parts[0];
      const encodedPayload = parts[1];
      const encodedSignature = parts[2];
      if (
        encodedHeader === undefined ||
        encodedPayload === undefined ||
        encodedSignature === undefined
      ) {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const expectedSignature = createHmac("sha256", deploymentMasterKey)
        .update(signingInput)
        .digest();

      let providedSignature: Buffer;
      try {
        providedSignature = Buffer.from(encodedSignature, "base64url");
      } catch {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      if (providedSignature.length !== expectedSignature.length) {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      if (!timingSafeEqual(providedSignature, expectedSignature)) {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      let header: unknown;
      try {
        header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
      } catch {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      if (!isHeader(header)) {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
      } catch {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      if (!isDispatchPermitClaims(payload)) {
        return error<DispatchPermitClaims>("PERMIT_INVALID", "Dispatch Permit is invalid.");
      }

      const now = Math.floor(Date.now() / 1000);
      if (payload.expiresAt <= now) {
        return error<DispatchPermitClaims>(
          "PERMIT_EXPIRED",
          "Dispatch Permit expired.",
          "EXPLICIT_RESUME",
        );
      }

      return { ok: true, value: payload };
    },
  };
}

function isHeader(value: unknown): value is { alg: "HS256"; typ: "JWT" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { alg?: unknown }).alg === "HS256" &&
    (value as { typ?: unknown }).typ === "JWT"
  );
}

function isDispatchPermitClaims(value: unknown): value is DispatchPermitClaims {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "DISPATCH_PERMIT" &&
    typeof (value as { attemptId?: unknown }).attemptId === "string" &&
    typeof (value as { snapshotDigest?: unknown }).snapshotDigest === "string" &&
    typeof (value as { issuedAt?: unknown }).issuedAt === "number" &&
    typeof (value as { expiresAt?: unknown }).expiresAt === "number"
  );
}

export async function deriveDeploymentMasterKey(secretFilePath: string): Promise<Uint8Array> {
  const invalid = () => new Error("DEPLOYMENT_MASTER_KEY_INVALID");

  let stats: Stats;
  try {
    stats = await lstat(secretFilePath);
  } catch {
    throw invalid();
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw invalid();
  }

  if ((stats.mode & 0o777) !== 0o600) {
    throw invalid();
  }

  const processUid = process.getuid?.();
  if (processUid !== undefined && stats.uid !== processUid) {
    throw invalid();
  }

  if (stats.size > 256) {
    throw invalid();
  }

  let raw: string;
  try {
    raw = (await readFile(secretFilePath)).toString("utf8");
  } catch {
    throw invalid();
  }

  if (!HEX_SECRET_PATTERN.test(raw)) {
    throw invalid();
  }

  const bytes = Buffer.from(raw, "hex");
  if (bytes.length !== 32) {
    throw invalid();
  }

  return new Uint8Array(bytes);
}
