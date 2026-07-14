import { expect, test } from "bun:test";
import { runCli } from "../../../src/cli/command.ts";

test("runner commands expose canonical pairing and foreground service controls", async () => {
  const calls: string[] = [];
  const output: string[] = [];
  const management = {
    pairBegin: async () => {
      calls.push("pairBegin");
      return { approvalUrl: "https://collab.test/runners/pairing/pair_1" };
    },
    pairComplete: async () => {
      calls.push("pairComplete");
      return { paired: true as const, runnerId: "runner_1" };
    },
    install: async () => {
      calls.push("install");
      return { state: "INSTALLED" as const, label: "dev.2collab.runner" };
    },
    start: async () => {
      calls.push("start");
      return { state: "STARTING" as const, runnerId: "runner_1" };
    },
    status: async () => {
      calls.push("status");
      return { state: "RUNNING" as const, runnerId: "runner_1" };
    },
    configureProject: async () => {
      calls.push("configureProject");
      return { projectId: "project_1" };
    },
    installDefaultProfile: async () => {
      calls.push("installDefaultProfile");
      return { adapter: "CODEX" };
    },
    registerMapping: async (input: unknown) => {
      calls.push(`registerMapping:${JSON.stringify(input)}`);
      return { runnerId: "runner_1", projectId: "project_1", revision: 1 };
    },
    advertiseProfile: async (input: unknown) => {
      calls.push(`advertiseProfile:${JSON.stringify(input)}`);
      return { runnerId: "runner_1", profileId: "profile_1", version: 1 };
    },
  } as never;
  const dependencies = {
    environment: {},
    runtimeVersion: "1.3.10",
    runnerManagement: management,
  };
  for (const args of [
    ["runner", "pair", "begin"],
    ["runner", "pair", "complete"],
    ["runner", "install"],
    ["runner", "start"],
    ["runner", "status"],
    [
      "runner",
      "project",
      "configure",
      "--project",
      "project_1",
      "--repository",
      "repository_1",
      "--revision",
      "1",
      "--checkout",
      "/repo",
      "--base-branch",
      "main",
    ],
    ["runner", "profile", "install-default", "--runtime", "CODEX", "--id", "profile_1"],
    ["runner", "mapping", "register", "--project", "project_1", "--mapping-id", "opaque_mapping_1"],
    [
      "runner",
      "profile",
      "advertise",
      "--display-name",
      "Codex headless",
      "--runtime",
      "CODEX",
      "--hosts",
      "NATIVE",
      "--interactions",
      "HEADLESS",
      "--risk-summary",
      "Local command execution",
      "--fingerprint",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
  ]) {
    expect(
      await runCli(
        args,
        {
          log: (line) => output.push(line),
          error: (line) => output.push(line),
        },
        dependencies,
      ),
    ).toBe(0);
  }
  expect(calls).toEqual([
    "pairBegin",
    "pairComplete",
    "install",
    "start",
    "status",
    "configureProject",
    "installDefaultProfile",
    'registerMapping:{"projectId":"project_1","localMappingId":"opaque_mapping_1"}',
    'advertiseProfile:{"displayName":"Codex headless","adapter":"CODEX","hosts":["NATIVE"],"interactions":["HEADLESS"],"riskSummary":"Local command execution","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
  ]);
  expect(output).toHaveLength(9);
});

test("runner mapping replacement and profile update require exact CAS versions", async () => {
  const calls: unknown[] = [];
  const errors: string[] = [];
  const dependencies = {
    environment: {},
    runtimeVersion: "1.3.10",
    runnerManagement: {
      replaceMapping: async (input: unknown) => calls.push(input),
      advertiseProfile: async (input: unknown) => calls.push(input),
    },
  } as never;
  expect(
    await runCli(
      [
        "runner",
        "mapping",
        "replace",
        "--project",
        "project_1",
        "--mapping-id",
        "opaque_mapping_2",
        "--expected-revision",
        "1",
      ],
      { log: () => undefined, error: (line) => errors.push(line) },
      dependencies,
    ),
  ).toBe(0);
  expect(
    await runCli(
      [
        "runner",
        "profile",
        "advertise",
        "--id",
        "profile_1",
        "--expected-version",
        "1",
        "--display-name",
        "Codex headless",
        "--runtime",
        "CODEX",
        "--hosts",
        "NATIVE",
        "--interactions",
        "HEADLESS",
        "--risk-summary",
        "Local command execution",
        "--fingerprint",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      { log: () => undefined, error: (line) => errors.push(line) },
      dependencies,
    ),
  ).toBe(0);
  expect(calls).toEqual([
    { projectId: "project_1", localMappingId: "opaque_mapping_2", expectedRevision: 1 },
    {
      profileId: "profile_1",
      expectedVersion: 1,
      displayName: "Codex headless",
      adapter: "CODEX",
      hosts: ["NATIVE"],
      interactions: ["HEADLESS"],
      riskSummary: "Local command execution",
      fingerprint: "b".repeat(64),
    },
  ]);
  expect(errors).toEqual([]);
});
