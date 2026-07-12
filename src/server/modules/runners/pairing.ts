import { createHash, randomBytes } from "node:crypto";

export const RUNNER_PAIRING_SECONDS = 600;

export function runnerSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function runnerDigest(value: string): Promise<Uint8Array> {
  return Promise.resolve(createHash("sha256").update(value, "utf8").digest());
}

export function validRunnerId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
