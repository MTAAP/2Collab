import type { DeviceCredentialProvider } from "./api-client.ts";

const CLIENT_ID = "2collab-cli";
const SCOPE = "collab:cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const service = "dev.2collab.cli.device";
const keychainAvailable = process.platform === "darwin";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 32 * 1024;

type PendingCredential = Readonly<{
  version: 1;
  kind: "PENDING";
  deviceCode: string;
  userCode: string;
  approvalUrl: string;
  expiresAt: number;
  interval: number;
}>;

type BearerCredential = Readonly<{
  version: 1;
  kind: "BEARER";
  accessToken: string;
  expiresAt: number;
  scope: typeof SCOPE;
}>;

type StoredCredential = PendingCredential | BearerCredential;

export type DeviceCredentialStore = Readonly<{
  load(origin: string): Promise<unknown | undefined>;
  save(origin: string, credential: StoredCredential): Promise<void>;
}>;

export type DeviceEnrollment = Readonly<{
  begin(): Promise<
    Readonly<{
      userCode: string;
      approvalUrl: string;
      expiresAt: number;
      interval: number;
    }>
  >;
  complete(): Promise<Readonly<{ enrolled: true }>>;
}>;

async function security(
  arguments_: readonly string[],
): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  const process = Bun.spawn(["/usr/bin/security", ...arguments_], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
  };
}

const keychainStore: DeviceCredentialStore = {
  async load(origin) {
    if (!keychainAvailable) return undefined;
    const result = await security(["find-generic-password", "-s", service, "-a", origin, "-w"]);
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > MAX_CREDENTIAL_BYTES)
      return undefined;
    try {
      return JSON.parse(result.stdout.trim()) as unknown;
    } catch {
      return undefined;
    }
  },
  async save(origin, credential) {
    if (!keychainAvailable) throw new Error("OS_CREDENTIAL_STORE_UNAVAILABLE");
    const encoded = JSON.stringify(credential);
    if (Buffer.byteLength(encoded, "utf8") > MAX_CREDENTIAL_BYTES)
      throw new Error("OS_CREDENTIAL_STORE_FAILED");
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
  },
};

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
    throw new Error("DEVICE_ENROLLMENT_FAILED");
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("DEVICE_ENROLLMENT_FAILED");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "DEVICE_ENROLLMENT_FAILED") throw error;
    throw new Error("DEVICE_ENROLLMENT_FAILED");
  }
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function pendingCredential(value: unknown): PendingCredential | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const credential = value as Partial<PendingCredential>;
  return credential.version === 1 &&
    credential.kind === "PENDING" &&
    typeof credential.deviceCode === "string" &&
    credential.deviceCode.length >= 16 &&
    typeof credential.userCode === "string" &&
    credential.userCode.length >= 4 &&
    typeof credential.approvalUrl === "string" &&
    integer(credential.expiresAt, 1, Number.MAX_SAFE_INTEGER) !== undefined &&
    integer(credential.interval, 1, 300) !== undefined
    ? (credential as PendingCredential)
    : undefined;
}

function bearerCredential(value: unknown): BearerCredential | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const credential = value as Partial<BearerCredential>;
  return credential.version === 1 &&
    credential.kind === "BEARER" &&
    typeof credential.accessToken === "string" &&
    credential.accessToken.length >= 16 &&
    integer(credential.expiresAt, 1, Number.MAX_SAFE_INTEGER) !== undefined &&
    credential.scope === SCOPE
    ? (credential as BearerCredential)
    : undefined;
}

function deviceError(body: Record<string, unknown>): Error {
  switch (body.error) {
    case "authorization_pending":
      return new Error("DEVICE_AUTHORIZATION_PENDING");
    case "slow_down":
      return new Error("DEVICE_AUTHORIZATION_SLOW_DOWN");
    case "expired_token":
      return new Error("DEVICE_AUTHORIZATION_EXPIRED");
    case "access_denied":
      return new Error("DEVICE_AUTHORIZATION_DENIED");
    default:
      return new Error("DEVICE_ENROLLMENT_FAILED");
  }
}

export function createDeviceEnrollment(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  store: DeviceCredentialStore = keychainStore,
  clock: () => number = () => Math.floor(Date.now() / 1_000),
): DeviceEnrollment | undefined {
  if (store === keychainStore && !keychainAvailable) return undefined;
  const origin = new URL(baseUrl).origin;
  return {
    async begin() {
      const response = await fetcher(new URL("/api/auth/device/code", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
        redirect: "error",
      });
      const body = await boundedJson(response);
      if (!response.ok) throw deviceError(body);
      const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
      const userCode = typeof body.user_code === "string" ? body.user_code : "";
      const approvalUrl =
        typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : "";
      const expiresIn = integer(body.expires_in, 1, 60 * 60);
      const interval = integer(body.interval, 1, 300);
      let parsedApproval: URL;
      try {
        parsedApproval = new URL(approvalUrl);
      } catch {
        throw new Error("DEVICE_ENROLLMENT_FAILED");
      }
      if (
        deviceCode.length < 16 ||
        userCode.length < 4 ||
        parsedApproval.origin !== origin ||
        expiresIn === undefined ||
        interval === undefined
      )
        throw new Error("DEVICE_ENROLLMENT_FAILED");
      const expiresAt = clock() + expiresIn;
      await store.save(origin, {
        version: 1,
        kind: "PENDING",
        deviceCode,
        userCode,
        approvalUrl: parsedApproval.toString(),
        expiresAt,
        interval,
      });
      return {
        userCode,
        approvalUrl: parsedApproval.toString(),
        expiresAt,
        interval,
      };
    },
    async complete() {
      const pending = pendingCredential(await store.load(origin));
      if (!pending) throw new Error("DEVICE_ENROLLMENT_NOT_PENDING");
      if (pending.expiresAt <= clock()) throw new Error("DEVICE_AUTHORIZATION_EXPIRED");
      const response = await fetcher(new URL("/api/auth/device/token", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT,
          device_code: pending.deviceCode,
          client_id: CLIENT_ID,
        }),
        redirect: "error",
      });
      const body = await boundedJson(response);
      if (!response.ok) throw deviceError(body);
      const accessToken = typeof body.access_token === "string" ? body.access_token : "";
      const expiresIn = integer(body.expires_in, 1, 60 * 60);
      if (
        accessToken.length < 16 ||
        body.token_type !== "Bearer" ||
        body.scope !== SCOPE ||
        expiresIn === undefined
      )
        throw new Error("DEVICE_ENROLLMENT_FAILED");
      await store.save(origin, {
        version: 1,
        kind: "BEARER",
        accessToken,
        expiresAt: clock() + expiresIn,
        scope: SCOPE,
      });
      return { enrolled: true };
    },
  };
}

/** The packaged CLI uses only an OS credential store; ambient tokens are test-only. */
export function createDeviceCredentialProvider(
  environment: Readonly<Record<string, string | undefined>>,
  _fetcher: typeof fetch = fetch,
  store: DeviceCredentialStore = keychainStore,
  clock: () => number = () => Math.floor(Date.now() / 1_000),
): DeviceCredentialProvider | undefined {
  if (environment.NODE_ENV === "test") {
    const accessToken = environment.COLLAB_DEVICE_ACCESS_TOKEN;
    if (accessToken)
      return {
        headers: async () => ({ authorization: `Bearer ${accessToken}` }),
      };
  }
  const parsed = (() => {
    try {
      return new URL(environment.COLLAB_BASE_URL ?? "");
    } catch {
      return undefined;
    }
  })();
  if (!parsed || (store === keychainStore && !keychainAvailable)) return undefined;
  return {
    async headers() {
      const credential = bearerCredential(await store.load(parsed.origin));
      if (!credential) throw new Error("DEVICE_AUTHENTICATION_REQUIRED");
      if (credential.expiresAt <= clock()) throw new Error("DEVICE_AUTHENTICATION_EXPIRED");
      return { authorization: `Bearer ${credential.accessToken}` };
    },
  };
}
