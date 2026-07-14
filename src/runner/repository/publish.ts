import { createHash } from "node:crypto";
import type { PublishedGitReference } from "../../shared/contracts/runs.ts";

const MAX_GIT_OUTPUT_BYTES = 65_536;

export type GitCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  truncated: boolean;
}>;

export interface GitCommandRunner {
  run(directory: string, args: readonly string[]): Promise<GitCommandResult>;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Readonly<{ text: string; truncated: boolean }>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (bytes + next.value.byteLength > maximumBytes) {
        const remaining = maximumBytes - bytes;
        if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
      bytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), truncated };
}

export function createProcessGitCommandRunner(): GitCommandRunner {
  return {
    async run(directory, args) {
      const child = Bun.spawn(["git", "-C", directory, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        readBounded(child.stdout, MAX_GIT_OUTPUT_BYTES),
        readBounded(child.stderr, MAX_GIT_OUTPUT_BYTES),
      ]);
      return { exitCode, stdout: stdout.text, truncated: stdout.truncated };
    },
  };
}

export function remoteIdentityFromUrl(url: string): string {
  return `sha256:${createHash("sha256").update(url, "utf8").digest("hex")}`;
}

function safeRemoteName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export type RemoteObservation =
  | Readonly<{ kind: "AVAILABLE"; commit: string | null }>
  | Readonly<{ kind: "UNAVAILABLE" }>;

export async function verifyConfiguredRemote(
  git: GitCommandRunner,
  repositoryRoot: string,
  remoteName: string,
  expectedIdentity: string,
): Promise<boolean> {
  if (!safeRemoteName(remoteName)) return false;
  const [fetch, push] = await Promise.all([
    git.run(repositoryRoot, ["remote", "get-url", "--all", remoteName]),
    git.run(repositoryRoot, ["remote", "get-url", "--push", "--all", remoteName]),
  ]);
  if (fetch.exitCode !== 0 || push.exitCode !== 0 || fetch.truncated || push.truncated)
    return false;
  const fetchUrls = fetch.stdout.trim().split("\n").filter(Boolean);
  const pushUrls = push.stdout.trim().split("\n").filter(Boolean);
  return (
    fetchUrls.length === 1 &&
    pushUrls.length === 1 &&
    fetchUrls[0] === pushUrls[0] &&
    remoteIdentityFromUrl(fetchUrls[0] ?? "") === expectedIdentity
  );
}

export async function observeRemoteReference(
  git: GitCommandRunner,
  repositoryRoot: string,
  remoteName: string,
  remoteRef: string,
): Promise<RemoteObservation> {
  const result = await git.run(repositoryRoot, ["ls-remote", "--refs", remoteName, remoteRef]);
  if (result.exitCode !== 0 || result.truncated) return { kind: "UNAVAILABLE" };
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return { kind: "AVAILABLE", commit: null };
  if (lines.length !== 1) return { kind: "UNAVAILABLE" };
  const [commit, ref] = lines[0]?.split(/\s+/, 2) ?? [];
  if (ref !== remoteRef || !commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    return { kind: "UNAVAILABLE" };
  }
  return { kind: "AVAILABLE", commit };
}

export async function publishExactHead(
  input: Readonly<{
    git: GitCommandRunner;
    repositoryRoot: string;
    worktreePath: string;
    remoteName: string;
    remoteIdentity: string;
    remoteRef: string;
    head: string;
    clock: () => number;
  }>,
): Promise<PublishedGitReference | null> {
  if (
    !(await verifyConfiguredRemote(
      input.git,
      input.repositoryRoot,
      input.remoteName,
      input.remoteIdentity,
    ))
  ) {
    return null;
  }
  const push = await input.git.run(input.worktreePath, [
    "push",
    "--porcelain",
    input.remoteName,
    `${input.head}:${input.remoteRef}`,
  ]);
  if (push.exitCode !== 0) return null;
  const observed = await observeRemoteReference(
    input.git,
    input.repositoryRoot,
    input.remoteName,
    input.remoteRef,
  );
  if (observed.kind !== "AVAILABLE" || observed.commit !== input.head) return null;
  return {
    remoteIdentity: input.remoteIdentity,
    remoteRef: input.remoteRef,
    commitSha: input.head as never,
    verifiedAt: input.clock() as never,
  };
}
