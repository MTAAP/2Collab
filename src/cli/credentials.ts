import { randomUUID } from "node:crypto";
import { createDpopProof, dpopThumbprint } from "../shared/dpop.ts";
import type { DeviceCredentialProvider } from "./api-client.ts";

type StoredCredential = Readonly<{
  privateJwk: JsonWebKey;
  deviceId: string;
  senderKeyThumbprint: string;
  nonce: string;
  accessToken?: string;
  refreshCredential?: string;
  accessExpiresAt?: number;
  pendingDeviceCode?: string;
  pendingDeviceCodeId?: string;
}>;

export type DeviceEnrollment = Readonly<{
  begin(): Promise<Readonly<{ deviceCodeId: string; deviceCode: string; approvalUrl: string }>>;
  complete(): Promise<Readonly<{ enrolled: true }>>;
}>;

const service = "dev.2collab.cli.device";
const keychainAvailable = process.platform === "darwin";

async function security(
  arguments_: readonly string[],
): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  const process = Bun.spawn(["/usr/bin/security", ...arguments_], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return { exitCode: await process.exited, stdout: await new Response(process.stdout).text() };
}

async function load(origin: string): Promise<StoredCredential | undefined> {
  if (!keychainAvailable) return undefined;
  const result = await security(["find-generic-password", "-s", service, "-a", origin, "-w"]);
  if (result.exitCode !== 0 || result.stdout.length > 32 * 1024) return undefined;
  try {
    return JSON.parse(result.stdout.trim()) as StoredCredential;
  } catch {
    return undefined;
  }
}

async function save(origin: string, credential: StoredCredential): Promise<void> {
  if (!keychainAvailable) throw new Error("OS_CREDENTIAL_STORE_UNAVAILABLE");
  const encoded = JSON.stringify(credential);
  const result = await security([
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    origin,
    "-w",
    encoded,
  ]);
  if (result.exitCode !== 0) throw new Error("OS_CREDENTIAL_STORE_FAILED");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("DEVICE_ENROLLMENT_FAILED");
  const body = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok || body.ok !== true || !body.value || typeof body.value !== "object")
    throw new Error("DEVICE_ENROLLMENT_FAILED");
  return body.value as Record<string, unknown>;
}

export function createDeviceEnrollment(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): DeviceEnrollment | undefined {
  if (!keychainAvailable) return undefined;
  const origin = new URL(baseUrl).origin;
  return {
    async begin() {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      const senderKeyThumbprint = dpopThumbprint(privateJwk);
      const deviceId = `cli_${randomUUID().replaceAll("-", "")}`;
      const value = await responseJson(
        await fetcher(new URL("/api/v1/device/authorization", origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `device_begin_${randomUUID().replaceAll("-", "")}`,
            deviceId,
            senderKeyThumbprint,
          }),
          redirect: "error",
        }),
      );
      const deviceCodeId = String(value.deviceCodeId ?? "");
      const deviceCode = String(value.deviceCode ?? "");
      if (!deviceCodeId || deviceCode.length < 32) throw new Error("DEVICE_ENROLLMENT_FAILED");
      await save(origin, {
        privateJwk,
        deviceId,
        senderKeyThumbprint,
        nonce: randomUUID().replaceAll("-", ""),
        pendingDeviceCode: deviceCode,
        pendingDeviceCodeId: deviceCodeId,
      });
      return {
        deviceCodeId,
        deviceCode,
        approvalUrl: new URL(
          `/device/authorize/${encodeURIComponent(deviceCodeId)}`,
          origin,
        ).toString(),
      };
    },
    async complete() {
      const pending = await load(origin);
      if (!pending?.pendingDeviceCode) throw new Error("DEVICE_ENROLLMENT_NOT_PENDING");
      const value = await responseJson(
        await fetcher(new URL("/api/v1/device/token", origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `device_exchange_${randomUUID().replaceAll("-", "")}`,
            deviceCode: pending.pendingDeviceCode,
            senderKeyThumbprint: pending.senderKeyThumbprint,
          }),
          redirect: "error",
        }),
      );
      const accessToken = String(value.accessToken ?? "");
      const refreshCredential = String(value.refreshCredential ?? "");
      const accessExpiresAt = Number(value.accessExpiresAt);
      if (
        accessToken.length < 32 ||
        refreshCredential.length < 32 ||
        !Number.isInteger(accessExpiresAt)
      )
        throw new Error("DEVICE_ENROLLMENT_FAILED");
      await save(origin, {
        ...pending,
        accessToken,
        refreshCredential,
        accessExpiresAt,
        pendingDeviceCode: undefined,
        pendingDeviceCodeId: undefined,
      });
      return { enrolled: true };
    },
  };
}

/** The packaged CLI uses only an OS credential store; ambient tokens are test-only. */
export function createDeviceCredentialProvider(
  environment: Readonly<Record<string, string | undefined>>,
  fetcher: typeof fetch = fetch,
): DeviceCredentialProvider | undefined {
  if (environment.NODE_ENV === "test") {
    const accessToken = environment.COLLAB_DEVICE_ACCESS_TOKEN;
    const proof = environment.COLLAB_DPOP_PROOF;
    const nonce = environment.COLLAB_DPOP_NONCE;
    if (accessToken && proof && nonce)
      return {
        headers: async () => ({
          authorization: `DPoP ${accessToken}`,
          dpop: proof,
          "dpop-nonce": nonce,
        }),
      };
  }
  const parsed = (() => {
    try {
      return new URL(environment.COLLAB_BASE_URL ?? "");
    } catch {
      return undefined;
    }
  })();
  if (!parsed || !keychainAvailable) return undefined;
  return {
    async headers({ method, url }) {
      let credential = await load(parsed.origin);
      if (!credential?.accessToken || !credential.refreshCredential)
        throw new Error("DEVICE_AUTHENTICATION_REQUIRED");
      if ((credential.accessExpiresAt ?? 0) <= Math.floor(Date.now() / 1_000) + 30) {
        const value = await responseJson(
          await fetcher(new URL("/api/v1/device/refresh", parsed.origin), {
            method: "POST",
            headers: { "content-type": "application/json" },
            redirect: "error",
            body: JSON.stringify({
              idempotencyKey: `device_refresh_${randomUUID().replaceAll("-", "")}`,
              refreshCredential: credential.refreshCredential,
              senderKeyThumbprint: credential.senderKeyThumbprint,
            }),
          }),
        );
        credential = {
          ...credential,
          accessToken: String(value.accessToken),
          refreshCredential: String(value.refreshCredential),
          accessExpiresAt: Number(value.accessExpiresAt),
        };
        await save(parsed.origin, credential);
      }
      const accessToken = credential.accessToken;
      if (!accessToken) throw new Error("DEVICE_AUTHENTICATION_REQUIRED");
      return {
        authorization: `DPoP ${accessToken}`,
        dpop: await createDpopProof({
          privateJwk: credential.privateJwk,
          method,
          url,
          nonce: credential.nonce,
          accessToken,
        }),
        "dpop-nonce": credential.nonce,
        "dpop-key-thumbprint": credential.senderKeyThumbprint,
      };
    },
  };
}
