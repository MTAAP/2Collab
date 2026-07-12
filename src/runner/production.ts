import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRunnerCryptography,
  type RunnerKeyPair,
} from "../server/modules/runners/runner-cryptography.ts";
import type { Result } from "../shared/contracts/result.ts";
import { openRunnerDatabase } from "./db/connection.ts";
import {
  createRunnerCredentialStore,
  type StoredRunnerCredential,
} from "./credentials/runner-store.ts";
import { createSqliteRunnerOutboundStore } from "./transport/sqlite-outbound-store.ts";
import { createRunnerWssClient } from "./transport/wss-client.ts";

type Store = ReturnType<typeof createRunnerCredentialStore>;
type DeviceCredentialProvider = Readonly<{
  headers(input: Readonly<{ method: "GET" | "POST"; url: string }>): Promise<HeadersInit>;
}>;
type JsonResult<T> = Result<T>;

async function boundedResult<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("RUNNER_API_INVALID");
  const result = JSON.parse(text) as JsonResult<T>;
  if (!response.ok || !result.ok)
    throw new Error(result.ok ? "RUNNER_API_INVALID" : result.error.code);
  return result.value;
}

function proof(
  keyPair: RunnerKeyPair,
  purpose: string,
  accessToken = purpose,
  nonce = purpose,
  uri = purpose,
) {
  const crypto = createRunnerCryptography();
  return crypto.signRunnerKeyProof(keyPair, {
    jti: randomUUID().replaceAll("-", ""),
    htm: "POST",
    htu: uri,
    iat: Math.floor(Date.now() / 1_000),
    nonce,
    ath: createHash("sha256").update(accessToken).digest("hex"),
  });
}

export function createProductionRunnerManagement(
  input: Readonly<{
    baseUrl: string;
    home: string;
    executable: string;
    deviceCredentials: DeviceCredentialProvider;
    fetch?: typeof fetch;
    store?: Store;
  }>,
) {
  const fetcher = input.fetch ?? fetch;
  const origin = new URL(input.baseUrl).origin;
  const store = input.store ?? createRunnerCredentialStore();
  const cryptography = createRunnerCryptography();
  const post = async <T>(path: string, body: unknown, authenticated = false): Promise<T> => {
    const url = new URL(path, origin).toString();
    const headers = authenticated
      ? await input.deviceCredentials.headers({ method: "POST", url })
      : {};
    return boundedResult<T>(
      await fetcher(url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
      }),
    );
  };
  const requireStored = async (): Promise<StoredRunnerCredential> => {
    const value = await store.load(origin);
    if (!value) throw new Error("RUNNER_PAIRING_REQUIRED");
    return value;
  };

  const management = {
    async pairBegin() {
      const keyPair = await cryptography.generateKeyPair();
      const keyId = `runner_key_${randomUUID().replaceAll("-", "")}`;
      const value = await post<{ pairingId: string; pairingSecret: string; expiresAt: number }>(
        "/api/v1/runners/pairing/begin",
        { idempotencyKey: `runner_pair_${randomUUID().replaceAll("-", "")}` },
        true,
      );
      await store.save(origin, {
        keyPair,
        keyId,
        pendingPairingId: value.pairingId,
        pendingPairingSecret: value.pairingSecret,
      });
      return {
        pairingId: value.pairingId,
        expiresAt: value.expiresAt,
        approvalUrl: new URL(
          `/runners/pairing/${encodeURIComponent(value.pairingId)}`,
          origin,
        ).toString(),
      };
    },
    async pairComplete() {
      const pending = await requireStored();
      if (!pending.pendingPairingSecret || !pending.pendingPairingId)
        throw new Error("RUNNER_PAIRING_NOT_PENDING");
      const value = await post<{ runnerId: string; runnerEpoch: number; runnerCredential: string }>(
        "/api/v1/runners/pairing/consume",
        {
          idempotencyKey: `runner_consume_${randomUUID().replaceAll("-", "")}`,
          pairingSecret: pending.pendingPairingSecret,
          keyId: pending.keyId,
          keyProof: proof(pending.keyPair, pending.keyId),
        },
      );
      await store.save(origin, {
        keyPair: pending.keyPair,
        keyId: pending.keyId,
        runnerId: value.runnerId,
        runnerEpoch: value.runnerEpoch,
        runnerCredential: value.runnerCredential,
      });
      return { paired: true as const, runnerId: value.runnerId };
    },
    async status() {
      const value = await store.load(origin);
      if (!value?.runnerCredential)
        return value?.pendingPairingId
          ? { state: "PAIRING" as const, pairingId: value.pendingPairingId }
          : { state: "UNPAIRED" as const };
      const domain = `gui/${process.getuid?.() ?? 0}`;
      const service = await Bun.spawn(["/bin/launchctl", "print", `${domain}/dev.2collab.runner`], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      return {
        state: service === 0 ? ("RUNNING" as const) : ("STOPPED" as const),
        runnerId: value.runnerId,
      };
    },
    async install() {
      const current = await management.status();
      if (current.state === "UNPAIRED")
        return { state: "CONFIRMATION_REQUIRED" as const, ...(await management.pairBegin()) };
      if (current.state === "PAIRING") await management.pairComplete();
      const directory = join(input.home, "Library", "LaunchAgents");
      const target = join(directory, "dev.2collab.runner.plist");
      const temporary = `${target}.${process.pid}.tmp`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.2collab.runner</string><key>ProgramArguments</key><array><string>${input.executable.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string><string>runner</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>COLLAB_BASE_URL</key><string>${origin.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${join(input.home, ".collab", "runner.log")}</string><key>StandardErrorPath</key><string>${join(input.home, ".collab", "runner.error.log")}</string></dict></plist>\n`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(join(input.home, ".collab"), { recursive: true, mode: 0o700 });
      await writeFile(temporary, xml, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
      await chmod(target, 0o600);
      const domain = `gui/${process.getuid?.() ?? 0}`;
      await Bun.spawn(["/bin/launchctl", "bootout", domain, target], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      const code = await Bun.spawn(["/bin/launchctl", "bootstrap", domain, target], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      if (code !== 0) throw new Error("RUNNER_SERVICE_INSTALL_FAILED");
      return { state: "INSTALLED" as const, label: "dev.2collab.runner" };
    },
    async start() {
      const credential = await requireStored();
      if (!credential.runnerCredential || !credential.runnerId)
        throw new Error("RUNNER_PAIRING_REQUIRED");
      const database = openRunnerDatabase(join(input.home, ".collab", "runner.db"));
      const httpsEndpoint = new URL("/runner/v1", origin).toString();
      const wssEndpoint = new URL(httpsEndpoint);
      wssEndpoint.protocol = "wss:";
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const client = createRunnerWssClient({
        endpoint: wssEndpoint.toString(),
        supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
        outboundStore: createSqliteRunnerOutboundStore(database),
        issueAccess: async () => {
          const issue = await post<{ accessToken: string; nonce: string }>(
            "/api/v1/runners/pairing/token",
            {
              runnerCredential: credential.runnerCredential,
              keyProof: proof(credential.keyPair, credential.keyId),
            },
          );
          return {
            ...issue,
            proof: cryptography.signRunnerRequestProof(credential.keyPair, {
              jti: randomUUID().replaceAll("-", ""),
              method: "GET",
              uri: httpsEndpoint,
              iat: Math.floor(Date.now() / 1_000),
              nonce: issue.nonce,
              accessTokenHash: createHash("sha256").update(issue.accessToken).digest("hex"),
            }),
          };
        },
        onEnvelope: async (envelope) => {
          if (envelope.body.kind === "HEARTBEAT_ACK" && !heartbeat)
            heartbeat = setInterval(
              () => client.send({ kind: "HEARTBEAT", repositoryObservations: [] }),
              10_000,
            );
          // Delivery is deliberately not acknowledged until the local execution composition starts it.
        },
      });
      await client.start();
      const initial = setInterval(() => {
        if (client.state === "ACTIVE") {
          client.send({ kind: "HEARTBEAT", repositoryObservations: [] });
          clearInterval(initial);
        }
      }, 100);
      const stop = () => {
        clearInterval(initial);
        if (heartbeat) clearInterval(heartbeat);
        client.stop();
        database.close();
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      return { state: "STARTING" as const, runnerId: credential.runnerId };
    },
  };
  return management;
}

export type ProductionRunnerManagement = ReturnType<typeof createProductionRunnerManagement>;
