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
  ]);
  expect(output).toHaveLength(7);
});
