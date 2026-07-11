import { describe, expect, test } from "bun:test";
import { type CliIo, runCli } from "../../src/cli/command.ts";

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      error: (line) => stderr.push(line),
      log: (line) => stdout.push(line),
    },
    stderr,
    stdout,
  };
}

describe("collab CLI", () => {
  test("prints the application version", async () => {
    const capture = captureIo();

    const exitCode = await runCli(["--version"], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toEqual(["2Collab 0.1.0"]);
    expect(capture.stderr).toEqual([]);
  });

  test("reports honest bootstrap diagnostics", async () => {
    const capture = captureIo();

    const exitCode = await runCli(["doctor"], capture.io, {
      environment: {},
      runtimeVersion: "1.3.10",
    });

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("Runtime: Bun 1.3.10");
    expect(capture.stdout.join("\n")).toContain("Configuration: development 127.0.0.1:3210");
    expect(capture.stdout.join("\n")).toContain("Status: READY (bootstrap diagnostics only)");
    expect(capture.stdout.join("\n")).not.toContain("connector ready");
    expect(capture.stdout.join("\n")).not.toContain("runner ready");
  });

  test("returns usage error for an unknown command", async () => {
    const capture = captureIo();

    const exitCode = await runCli(["launch"], capture.io);

    expect(exitCode).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([
      "Unknown command: launch",
      "Run 'collab --help' to list bootstrap commands.",
    ]);
  });

  test("routes two-step device enrollment through the OS credential seam", async () => {
    const output: string[] = [];
    const base = {
      environment: {},
      runtimeVersion: "1.3.10",
      deviceEnrollment: {
        begin: async () => ({
          deviceCodeId: "device_code_1",
          deviceCode: "device-code-secret-with-at-least-thirty-two-bytes",
          approvalUrl: "https://collab.example/device/authorize/device_code_1",
        }),
        complete: async () => ({ enrolled: true as const }),
      },
    };
    expect(
      await runCli(
        ["auth", "begin"],
        { log: (line) => output.push(line), error: (line) => output.push(line) },
        base,
      ),
    ).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}").deviceCodeId).toBe("device_code_1");
    expect(
      await runCli(
        ["auth", "complete"],
        { log: (line) => output.push(line), error: (line) => output.push(line) },
        base,
      ),
    ).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toEqual({ enrolled: true });
  });
});
