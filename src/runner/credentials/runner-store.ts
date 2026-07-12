import type { RunnerKeyPair } from "../../server/modules/runners/runner-cryptography.ts";

export type StoredRunnerCredential = Readonly<{
  keyPair: RunnerKeyPair;
  keyId: string;
  runnerId?: string;
  runnerEpoch?: number;
  runnerCredential?: string;
  pendingPairingSecret?: string;
  pendingPairingId?: string;
}>;

const SERVICE = "dev.2collab.runner";

async function security(arguments_: readonly string[]) {
  const child = Bun.spawn(["/usr/bin/security", ...arguments_], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text() };
}

export function createRunnerCredentialStore() {
  if (process.platform !== "darwin") throw new Error("OS_CREDENTIAL_STORE_UNAVAILABLE");
  return {
    async load(origin: string): Promise<StoredRunnerCredential | undefined> {
      const result = await security(["find-generic-password", "-s", SERVICE, "-a", origin, "-w"]);
      if (result.exitCode !== 0 || result.stdout.length > 64 * 1024) return undefined;
      try {
        return JSON.parse(result.stdout.trim()) as StoredRunnerCredential;
      } catch {
        throw new Error("RUNNER_CREDENTIAL_STORE_CORRUPT");
      }
    },
    async save(origin: string, credential: StoredRunnerCredential): Promise<void> {
      const encoded = JSON.stringify(credential);
      const result = await security([
        "add-generic-password",
        "-U",
        "-s",
        SERVICE,
        "-a",
        origin,
        "-w",
        encoded,
      ]);
      if (result.exitCode !== 0) throw new Error("OS_CREDENTIAL_STORE_FAILED");
    },
  };
}
