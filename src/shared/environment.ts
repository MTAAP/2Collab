import { z } from "zod";

const PLACEHOLDER_SESSION_SECRET = "replace-with-a-random-production-secret";

const serverEnvironmentSchema = z.object({
  BACKUP_DIR: z.string().min(1).default("./backups"),
  BOOTSTRAP_SECRET_FILE: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default("./data"),
  DEPLOYMENT_MASTER_KEY_FILE: z.string().min(1).optional(),
  HOST: z.string().min(1).default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
  PUBLIC_BASE_URL: z.string().min(1).default("http://localhost:3210"),
  RUNNER_COMPOSITION_MODULE: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  WEBAUTHN_RP_ID: z.string().min(1).default("localhost"),
  WEBAUTHN_RP_NAME: z.string().min(1).default("2Collab"),
});

export type ServerEnvironment = {
  backupDir: string;
  bootstrapSecretFile: string | undefined;
  dataDir: string;
  deploymentMasterKeyFile: string | undefined;
  hostname: string;
  mode: "development" | "test" | "production";
  port: number;
  publicBaseUrl: string;
  rpId: string;
  rpName: string;
  runnerCompositionModule: string | undefined;
  sessionSecret: string | undefined;
};

export function readServerEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): ServerEnvironment {
  const parsed = serverEnvironmentSchema.safeParse(source);

  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid server environment: ${reasons.join("; ")}`);
  }

  if (
    parsed.data.NODE_ENV === "production" &&
    (!parsed.data.SESSION_SECRET ||
      parsed.data.SESSION_SECRET === PLACEHOLDER_SESSION_SECRET ||
      new Set(parsed.data.SESSION_SECRET).size < 12)
  ) {
    throw new Error(
      "Invalid server environment: SESSION_SECRET must be random and non-placeholder in production",
    );
  }

  if (parsed.data.NODE_ENV === "production") {
    let publicUrl: URL;
    try {
      publicUrl = new URL(parsed.data.PUBLIC_BASE_URL);
    } catch {
      throw new Error(
        "Invalid server environment: PUBLIC_BASE_URL must be an absolute HTTPS origin in production",
      );
    }
    if (
      publicUrl.protocol !== "https:" ||
      publicUrl.username !== "" ||
      publicUrl.password !== "" ||
      publicUrl.pathname !== "/" ||
      publicUrl.search !== "" ||
      publicUrl.hash !== ""
    )
      throw new Error(
        "Invalid server environment: PUBLIC_BASE_URL must be an absolute HTTPS origin in production",
      );
    const host = publicUrl.hostname.toLowerCase();
    const rpId = parsed.data.WEBAUTHN_RP_ID.toLowerCase();
    if (host !== rpId && !host.endsWith(`.${rpId}`))
      throw new Error("Invalid server environment: WEBAUTHN_RP_ID must match PUBLIC_BASE_URL");
    if (!parsed.data.DEPLOYMENT_MASTER_KEY_FILE)
      throw new Error(
        "Invalid server environment: DEPLOYMENT_MASTER_KEY_FILE is required in production",
      );
  }

  return {
    backupDir: parsed.data.BACKUP_DIR,
    bootstrapSecretFile: parsed.data.BOOTSTRAP_SECRET_FILE,
    dataDir: parsed.data.DATA_DIR,
    deploymentMasterKeyFile: parsed.data.DEPLOYMENT_MASTER_KEY_FILE,
    hostname: parsed.data.HOST,
    mode: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    rpId: parsed.data.WEBAUTHN_RP_ID,
    rpName: parsed.data.WEBAUTHN_RP_NAME,
    runnerCompositionModule: parsed.data.RUNNER_COMPOSITION_MODULE,
    sessionSecret: parsed.data.SESSION_SECRET,
  };
}
