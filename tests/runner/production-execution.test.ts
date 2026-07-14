import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerDatabase } from "../../src/runner/db/connection.ts";
import { createLocalRunnerConfiguration } from "../../src/runner/local-configuration.ts";
import { createProductionRunnerExecution } from "../../src/runner/production-composition.ts";
import { createLocalProfileRegistry, fingerprintLocalProfile } from "../../src/runner/profiles.ts";
import { remoteIdentityFromUrl } from "../../src/runner/repository/publish.ts";
import type { RunnerEnvelope } from "../../src/shared/contracts/protocol.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonical(value)).digest("hex");
}

async function git(directory: string, arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", directory, ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

test("production execution creates one durable worktree and starts a real source-free Native process", async () => {
  const root = await mkdtemp(join(tmpdir(), "collab-production-execution-"));
  directories.push(root);
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await Bun.$`git init --bare ${remote}`.quiet();
  await Bun.$`git clone ${remote} ${checkout}`.quiet();
  await git(checkout, ["config", "user.email", "runner@example.invalid"]);
  await git(checkout, ["config", "user.name", "Runner Test"]);
  await Bun.write(join(checkout, "README.md"), "test\n");
  await git(checkout, ["add", "README.md"]);
  await git(checkout, ["commit", "-m", "base"]);
  await git(checkout, ["branch", "-M", "main"]);
  await git(checkout, ["push", "-u", "origin", "main"]);
  const baseCommit = await git(checkout, ["rev-parse", "HEAD"]);

  const executable = join(root, "codex");
  await Bun.write(executable, "#!/bin/sh\ncat\nprintf 'native-process-finished\\n'\n");
  await chmod(executable, 0o700);
  const database = openRunnerDatabase(join(root, "runner.db"));
  const profileDraft = {
    adapter: "CODEX" as const,
    executable,
    fixedArguments: [],
    promptTransport: {
      headless: "STDIN" as const,
      interactive: "TERMINAL_INPUT" as const,
    },
    supportedInteractions: ["HEADLESS" as const],
  };
  const profile = {
    ...profileDraft,
    fingerprint: fingerprintLocalProfile(profileDraft),
  };
  expect(
    createLocalProfileRegistry(database, () => 1_000).publish("profile_1", "profile_1", 1, profile),
  ).toMatchObject({ ok: true });
  const configuration = createLocalRunnerConfiguration(join(root, "runner-config.json"));
  configuration.saveProject({
    projectId: "project_1",
    repositoryId: "repository_1",
    mappingRevision: 1,
    checkout: await realpath(checkout),
    baseBranch: "main",
    remoteName: "origin",
    remoteIdentity: remoteIdentityFromUrl(remote),
    remoteRef: "refs/heads/main",
  });
  const sent: RunnerEnvelope["body"][] = [];
  const execution = createProductionRunnerExecution({
    database,
    configuration,
    managedRoot: join(root, "worktrees"),
    runnerId: "runner_1",
    ownerMemberId: "member_1",
    home: root,
    path: "/usr/bin:/bin",
    clock: () => 1_000,
    id: (() => {
      let next = 0;
      return (kind: string) => `${kind}_${++next}`;
    })(),
    send: (body) => {
      sent.push(body);
      return { ok: true, value: { queued: false } };
    },
    consumePermit: async () => ({ ok: true, value: { consumed: true } }),
  });
  const bootstrap = {
    schemaVersion: 1 as const,
    contextRecipe: { id: "recipe_1", version: 1, digest: "d".repeat(64) },
    references: [],
    omissions: [],
  };
  const contextEnvelopeDigest = digest(bootstrap);
  const layers = { typedVariables: {}, runGoal: "Inspect the repository" };
  const configurationDigest = "e".repeat(64);
  const instructions = {
    schemaVersion: 1 as const,
    configurationDigest,
    contextEnvelopeDigest,
    assemblyDigest: digest({
      configurationDigest,
      envelopeDigest: contextEnvelopeDigest,
      authoredRunInput: undefined,
    }),
    layers,
  };
  expect(
    await execution.launch({
      kind: "LAUNCH_ATTEMPT",
      deliveryId: "delivery_1",
      semanticDigest: "a".repeat(64),
      runId: "run_1",
      attemptId: "attempt_1",
      projectId: "project_1",
      repositoryId: "repository_1",
      runRevision: 1,
      attemptRevision: 1,
      worktreeIdentity: "worktree_1",
      dispatchPermit: "p".repeat(32),
      goal: "Inspect the repository",
      instructions,
      bootstrap,
      projectMappingRevision: 1,
      repositoryMode: "INSPECT_ONLY",
      repositoryAssurance: "ADVISORY",
      baseRevision: baseCommit as never,
      baseBranch: "main",
      intendedBranch: "collab/run_1",
      host: "NATIVE",
      interaction: "HEADLESS",
      profileVersionId: "profile_1",
      profileFingerprint: profile.fingerprint as never,
      policyExpiresAt: 1_100 as never,
      deadlineAt: 1_100 as never,
    }),
  ).toEqual({ ok: true, value: { started: true } });

  for (
    let index = 0;
    index < 100 &&
    !sent.some(
      (body) =>
        body.kind === "HEADLESS_OUTPUT_CHUNK" && body.text.includes("native-process-finished"),
    );
    index += 1
  )
    await Bun.sleep(10);
  expect(
    sent.some(
      (body) => body.kind === "ATTEMPT_EVENT" && body.payload.event.kind === "PROCESS_STARTED",
    ),
  ).toBe(true);
  expect(
    database
      .query<{ state: string; last_disposition: string }, [string]>(
        "SELECT state, last_disposition FROM local_processes WHERE attempt_id = ?",
      )
      .get("attempt_1"),
  ).toEqual({ state: "EXITED", last_disposition: "EXIT_CODE_0" });
  expect(
    sent.some(
      (body) =>
        body.kind === "HEADLESS_OUTPUT_CHUNK" && body.text.includes("Inspect the repository"),
    ),
  ).toBe(true);
  expect(
    sent.some(
      (body) =>
        body.kind === "HEADLESS_OUTPUT_CHUNK" && body.text.includes("native-process-finished"),
    ),
  ).toBe(true);
  expect(
    sent.some(
      (body) => body.kind === "ATTEMPT_EVENT" && body.payload.event.kind === "PROCESS_EXITED",
    ),
  ).toBe(true);
  expect(await git(join(root, "worktrees", "worktree_1"), ["rev-parse", "HEAD"])).toBe(baseCommit);
  database.close();
});
