import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
import { createLocalRunnerConfiguration } from "./local-configuration.ts";
import { createProductionRunnerExecution } from "./production-composition.ts";
import { createLocalProfileRegistry, fingerprintLocalProfile } from "./profiles.ts";
import { remoteIdentityFromUrl } from "./repository/publish.ts";
import { observeRepositoryBase } from "./repository/base-observation.ts";

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

function configurationIdempotencyKey(kind: "mapping" | "profile", values: unknown): string {
  return `runner_${kind}_${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;
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
      const value = await post<{
        pairingId: string;
        pairingSecret: string;
        expiresAt: number;
      }>(
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
      const value = await post<{
        runnerId: string;
        runnerEpoch: number;
        ownerMemberId: string;
        runnerCredential: string;
      }>("/api/v1/runners/pairing/consume", {
        idempotencyKey: `runner_consume_${randomUUID().replaceAll("-", "")}`,
        pairingSecret: pending.pendingPairingSecret,
        keyId: pending.keyId,
        keyProof: proof(pending.keyPair, pending.keyId),
      });
      await store.save(origin, {
        keyPair: pending.keyPair,
        keyId: pending.keyId,
        runnerId: value.runnerId,
        runnerEpoch: value.runnerEpoch,
        ownerMemberId: value.ownerMemberId,
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
        return {
          state: "CONFIRMATION_REQUIRED" as const,
          ...(await management.pairBegin()),
        };
      if (current.state === "PAIRING") await management.pairComplete();
      const directory = join(input.home, "Library", "LaunchAgents");
      const target = join(directory, "dev.2collab.runner.plist");
      const temporary = `${target}.${process.pid}.tmp`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.2collab.runner</string><key>ProgramArguments</key><array><string>${input.executable.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string><string>runner</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>COLLAB_BASE_URL</key><string>${origin.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string><key>PATH</key><string>${(Bun.env.PATH ?? "/usr/bin:/bin").replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${join(input.home, ".collab", "runner.log")}</string><key>StandardErrorPath</key><string>${join(input.home, ".collab", "runner.error.log")}</string></dict></plist>\n`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(join(input.home, ".collab"), {
        recursive: true,
        mode: 0o700,
      });
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
    async configureProject(
      configuration: Readonly<{
        projectId: string;
        repositoryId: string;
        mappingRevision: number;
        checkout: string;
        baseBranch: string;
        remoteName?: string;
        remoteRef?: string;
      }>,
    ) {
      const checkout = await realpath(configuration.checkout);
      const metadata = await lstat(checkout);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("RUNNER_PROJECT_MAPPING_INVALID");
      const remoteName = configuration.remoteName ?? "origin";
      const child = Bun.spawn(["git", "-C", checkout, "remote", "get-url", remoteName], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const [exitCode, url] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      const remoteUrl = url.trim();
      if (exitCode !== 0 || !remoteUrl || remoteUrl.includes("\n"))
        throw new Error("RUNNER_PROJECT_REMOTE_INVALID");
      return createLocalRunnerConfiguration(
        join(input.home, ".collab", "runner-config.json"),
      ).saveProject({
        projectId: configuration.projectId,
        repositoryId: configuration.repositoryId,
        mappingRevision: configuration.mappingRevision,
        checkout,
        baseBranch: configuration.baseBranch,
        remoteName,
        remoteIdentity: remoteIdentityFromUrl(remoteUrl),
        remoteRef: configuration.remoteRef ?? `refs/heads/${configuration.baseBranch}`,
      });
    },
    async installDefaultProfile(
      configuration: Readonly<{
        runtime: "CODEX" | "CLAUDE";
        profileVersionId: string;
        executable?: string;
      }>,
    ) {
      const executable =
        configuration.executable ??
        Bun.which(configuration.runtime === "CODEX" ? "codex" : "claude");
      if (!executable) throw new Error("RUNNER_PROFILE_EXECUTABLE_NOT_FOUND");
      const canonicalExecutable = await realpath(executable);
      if (
        basename(canonicalExecutable) !== (configuration.runtime === "CODEX" ? "codex" : "claude")
      )
        throw new Error("RUNNER_PROFILE_EXECUTABLE_INVALID");
      const draft = {
        adapter: configuration.runtime,
        executable: canonicalExecutable,
        fixedArguments: configuration.runtime === "CODEX" ? ["exec", "-"] : ["-p"],
        promptTransport: {
          headless: "STDIN" as const,
          interactive: "TERMINAL_INPUT" as const,
        },
        supportedInteractions: ["HEADLESS" as const],
      };
      const database = openRunnerDatabase(join(input.home, ".collab", "runner.db"));
      try {
        const profile = {
          ...draft,
          fingerprint: fingerprintLocalProfile(draft),
        };
        const saved = createLocalProfileRegistry(database, () =>
          Math.floor(Date.now() / 1_000),
        ).publish(configuration.profileVersionId, configuration.profileVersionId, 1, profile);
        if (!saved.ok) throw new Error(saved.error.code);
        return saved.value;
      } finally {
        database.close();
      }
    },
    async registerMapping(configuration: Readonly<{ projectId: string; localMappingId: string }>) {
      const credential = await requireStored();
      if (!credential.runnerId) throw new Error("RUNNER_PAIRING_REQUIRED");
      return post<{
        runnerId: string;
        projectId: string;
        revision: number;
        localMappingId: string;
        createdAt: number;
      }>(
        `/api/v1/runners/${encodeURIComponent(credential.runnerId)}/mappings`,
        {
          idempotencyKey: configurationIdempotencyKey("mapping", [
            "REGISTER",
            credential.runnerId,
            configuration.projectId,
            configuration.localMappingId,
          ]),
          projectId: configuration.projectId,
          localMappingId: configuration.localMappingId,
        },
        true,
      );
    },
    async replaceMapping(
      configuration: Readonly<{
        projectId: string;
        localMappingId: string;
        expectedRevision: number;
      }>,
    ) {
      const credential = await requireStored();
      if (!credential.runnerId) throw new Error("RUNNER_PAIRING_REQUIRED");
      return post<{
        runnerId: string;
        projectId: string;
        revision: number;
        localMappingId: string;
        createdAt: number;
      }>(
        `/api/v1/runners/${encodeURIComponent(credential.runnerId)}/mappings`,
        {
          idempotencyKey: configurationIdempotencyKey("mapping", [
            "REPLACE",
            credential.runnerId,
            configuration.projectId,
            configuration.localMappingId,
            configuration.expectedRevision,
          ]),
          ...configuration,
        },
        true,
      );
    },
    async advertiseProfile(
      configuration: Readonly<{
        profileId?: string;
        expectedVersion?: number;
        displayName: string;
        adapter: "CLAUDE" | "CODEX" | "PI" | "OPENCODE";
        hosts: readonly ("NATIVE" | "ORCA")[];
        interactions: readonly ("HEADLESS" | "INTERACTIVE")[];
        riskSummary: string;
        fingerprint: string;
      }>,
    ) {
      const credential = await requireStored();
      if (!credential.runnerId) throw new Error("RUNNER_PAIRING_REQUIRED");
      return post<{
        runnerId: string;
        profileId: string;
        version: number;
        fingerprint: string;
      }>(
        `/api/v1/runners/${encodeURIComponent(credential.runnerId)}/profiles`,
        {
          idempotencyKey: configurationIdempotencyKey("profile", [
            credential.runnerId,
            configuration.profileId ?? null,
            configuration.expectedVersion ?? null,
            configuration.displayName,
            configuration.adapter,
            configuration.hosts,
            configuration.interactions,
            configuration.riskSummary,
            configuration.fingerprint,
          ]),
          ...configuration,
        },
        true,
      );
    },
    async start() {
      const credential = await requireStored();
      if (!credential.runnerCredential || !credential.runnerId || !credential.ownerMemberId)
        throw new Error("RUNNER_PAIRING_REQUIRED");
      const database = openRunnerDatabase(join(input.home, ".collab", "runner.db"));
      const httpsEndpoint = new URL("/runner/v1", origin).toString();
      const wssEndpoint = new URL(httpsEndpoint);
      wssEndpoint.protocol = "wss:";
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const authority = new Map<string, (result: Result<Readonly<{ consumed: true }>>) => void>();
      let execution: ReturnType<typeof createProductionRunnerExecution>;
      const localConfiguration = createLocalRunnerConfiguration(
        join(input.home, ".collab", "runner-config.json"),
      );
      let client: ReturnType<typeof createRunnerWssClient>;
      const sendHeartbeat = async () => {
        const repositoryObservations = (
          await Promise.all(
            localConfiguration.listProjects().map(async (mapping) => {
              try {
                return await observeRepositoryBase({
                  projectId: mapping.projectId,
                  mappingRevision: mapping.mappingRevision,
                  repositoryRoot: mapping.checkout,
                  baseBranch: mapping.baseBranch,
                });
              } catch {
                return undefined;
              }
            }),
          )
        ).filter((value) => value !== undefined);
        client.send({ kind: "HEARTBEAT", repositoryObservations });
      };
      client = createRunnerWssClient({
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
            heartbeat = setInterval(() => void sendHeartbeat(), 10_000);
          if (envelope.body.kind === "AUTHORITY_RESPONSE") {
            const resolve = authority.get(envelope.body.requestId);
            if (resolve) {
              authority.delete(envelope.body.requestId);
              resolve(
                envelope.body.result.kind === "CONSUME_PERMIT"
                  ? { ok: true, value: { consumed: true } }
                  : {
                      ok: false,
                      error: {
                        code:
                          envelope.body.result.kind === "ERROR"
                            ? envelope.body.result.code
                            : "PERMIT_INVALID",
                        message: "Dispatch permit was rejected.",
                        retry: "NEVER",
                      },
                    },
              );
            }
          }
          if (envelope.body.kind === "LAUNCH_ATTEMPT") {
            const started = await execution.launch(envelope.body);
            if (started.ok)
              client.send({
                kind: "OPERATION_ACKNOWLEDGEMENT",
                eventId: `event_${randomUUID().replaceAll("-", "")}`,
                deliveryId: envelope.body.deliveryId,
                semanticDigest: envelope.body.semanticDigest,
              });
          }
          if (envelope.body.kind === "CANCEL_ATTEMPT") {
            const cancelled = await execution.cancel(envelope.body.attemptId, envelope.body.reason);
            if (cancelled.ok && cancelled.value.requested)
              client.send({
                kind: "OPERATION_ACKNOWLEDGEMENT",
                eventId: `event_${randomUUID().replaceAll("-", "")}`,
                deliveryId: envelope.body.deliveryId,
                semanticDigest: envelope.body.semanticDigest,
              });
          }
        },
      });
      execution = createProductionRunnerExecution({
        database,
        configuration: localConfiguration,
        managedRoot: join(input.home, ".collab", "worktrees"),
        runnerId: credential.runnerId,
        ownerMemberId: credential.ownerMemberId,
        home: input.home,
        path: Bun.env.PATH ?? "/usr/bin:/bin",
        send: (body) => client.send(body),
        consumePermit: ({ permit }) =>
          new Promise((resolve) => {
            const requestId = `request_${randomUUID().replaceAll("-", "")}`;
            const eventId = `event_${randomUUID().replaceAll("-", "")}`;
            const timeout = setTimeout(() => {
              authority.delete(requestId);
              resolve({
                ok: false,
                error: {
                  code: "PERMIT_TIMEOUT",
                  message: "Dispatch permit timed out.",
                  retry: "REFRESH",
                },
              });
            }, 10_000);
            authority.set(requestId, (result) => {
              clearTimeout(timeout);
              resolve(result);
            });
            const sent = client.send({
              kind: "CONSUME_DISPATCH_PERMIT",
              eventId,
              requestId,
              payload: { permit },
            });
            if (!sent.ok) {
              clearTimeout(timeout);
              authority.delete(requestId);
              resolve(sent);
            }
          }),
      });
      await client.start();
      const initial = setInterval(() => {
        if (client.state === "ACTIVE") {
          void sendHeartbeat();
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
