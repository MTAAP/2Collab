import type { Result } from "../../../shared/contracts/result.ts";

export type SupervisorLaunch = Readonly<{
  attemptId: string;
  worktree: Readonly<{ id: string }>;
  invocation: Readonly<{
    argv: readonly string[];
    prompt: Readonly<{ transport: "STDIN" | "ARGUMENT" | "TERMINAL_INPUT"; text: string }>;
  }>;
  environment: Readonly<Record<string, string>>;
  interaction: "HEADLESS" | "INTERACTIVE";
  assurance: "ADVISORY" | "ENFORCED";
  deadlineAt: number;
}>;

export type HostProcess = Readonly<{
  host: "NATIVE" | "ORCA";
  opaqueProcessId: string;
  interaction: "HEADLESS" | "INTERACTIVE";
  assurance: "ADVISORY";
}>;

export interface ExecutionHost {
  readonly host: "NATIVE" | "ORCA";
  start(execution: SupervisorLaunch): Promise<Result<HostProcess>>;
  cancel(process: HostProcess): Promise<Result<Readonly<{ requested: boolean }>>>;
  inspect(
    process: HostProcess,
  ): Promise<Result<Readonly<{ state: "RUNNING" | "EXITED" | "UNKNOWN" }>>>;
  attach(process: HostProcess): Promise<Result<Readonly<{ localAttachmentId: string }>>>;
}

export interface TrustedHostPort {
  start(input: SupervisorLaunch): Promise<Readonly<{ opaqueProcessId: string }>>;
  cancel(opaqueProcessId: string): Promise<boolean>;
  inspect(opaqueProcessId: string): Promise<"RUNNING" | "EXITED" | "UNKNOWN">;
  attach(opaqueProcessId: string): Promise<Readonly<{ localAttachmentId: string }>>;
}
