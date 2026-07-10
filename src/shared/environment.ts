import { z } from "zod";

const PLACEHOLDER_SESSION_SECRET = "replace-with-a-random-production-secret";

const serverEnvironmentSchema = z.object({
  DATA_DIR: z.string().min(1).default("./data"),
  HOST: z.string().min(1).default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
  SESSION_SECRET: z.string().min(32).optional(),
});

export type ServerEnvironment = {
  dataDir: string;
  hostname: string;
  mode: "development" | "test" | "production";
  port: number;
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

  return {
    dataDir: parsed.data.DATA_DIR,
    hostname: parsed.data.HOST,
    mode: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    sessionSecret: parsed.data.SESSION_SECRET,
  };
}
