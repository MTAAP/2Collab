import type { Result } from "../shared/contracts/result.ts";

export type RuntimeAdapter = "CLAUDE" | "CODEX";
export type InteractionMode = "HEADLESS" | "INTERACTIVE";
export type PromptTransport = "STDIN" | "ARGUMENT" | "TERMINAL_INPUT";

export type ProfileEnvironmentBinding =
  | Readonly<{ name: string; source: "LITERAL"; value: string }>
  | Readonly<{ name: string; source: "OS_CREDENTIAL"; reference: string }>;

export type CustomLaunchProfile = Readonly<{
  adapter: RuntimeAdapter;
  executable: string;
  fixedArguments: readonly string[];
  promptTransport: Readonly<{
    headless: "STDIN" | "ARGUMENT";
    interactive: "TERMINAL_INPUT" | "ARGUMENT";
  }>;
  supportedInteractions: readonly InteractionMode[];
  environment?: readonly ProfileEnvironmentBinding[];
  fingerprint: string;
}>;

export type PreparedExecutionRequest = Readonly<{
  profile: CustomLaunchProfile;
  profileVersionId: string;
  expectedFingerprint: string;
  interaction: InteractionMode;
  instructions: string;
  maximumRuntimeSeconds: number;
}>;

export type PreparedExecution = Readonly<{
  runtime: RuntimeAdapter;
  profileVersionId: string;
  profileFingerprint: string;
  invocation: Readonly<{ argv: readonly string[] }>;
  prompt: Readonly<{ transport: PromptTransport; text: string }>;
  interaction: InteractionMode;
  outputProtocol: "TEXT_AND_STRUCTURED_EVENTS";
  requirements: Readonly<{ maximumRuntimeSeconds: number }>;
}>;

export type RuntimeOutputEvent =
  | Readonly<{ kind: "STDOUT" | "STDERR"; text: string }>
  | Readonly<{ kind: "EXIT"; exitCode: number | null; signal: string | null }>
  | Readonly<{ kind: "STRUCTURED"; value: unknown }>;

export type NormalizedRuntimeEvent =
  | Readonly<{ kind: "OUTPUT"; stream: "STDOUT" | "STDERR"; text: string }>
  | Readonly<{ kind: "PROCESS_EXIT"; exitCode: number | null; signal: string | null }>
  | Readonly<{
      kind: "AGENT_OUTCOME";
      outcome: "CONTINUE" | "GOAL_ACHIEVED" | "ESCALATE";
      reason: string;
      evidenceReferences: readonly string[];
    }>;

export interface ExecutionAdapter {
  readonly runtime: RuntimeAdapter;
  prepare(request: PreparedExecutionRequest): Promise<Result<PreparedExecution>>;
  normalize(event: RuntimeOutputEvent): Result<NormalizedRuntimeEvent>;
}

export type SupervisorLaunch = Readonly<{
  attemptId: string;
  worktree: Readonly<{ id: string }>;
  invocation: Readonly<{
    argv: readonly string[];
    prompt: Readonly<{ transport: PromptTransport; text: string }>;
  }>;
  environment: Readonly<Record<string, string>>;
  interaction: InteractionMode;
  assurance: "ADVISORY" | "ENFORCED";
  deadlineAt: number;
}>;

export type HostProcess = Readonly<{
  host: "NATIVE" | "ORCA";
  opaqueProcessId: string;
  interaction: InteractionMode;
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

export interface RepositoryEnforcementAdapter {
  readonly assurance: "ADVISORY" | "ENFORCED";
  activate(
    input: Readonly<{
      worktree: Readonly<{ id: string }>;
      assurance: "ADVISORY" | "ENFORCED";
    }>,
  ): Promise<Result<Readonly<{ sessionId: string }>>>;
  inspect(
    sessionId: string,
  ): Promise<Result<Readonly<{ state: "ACTIVE" | "REVOKED"; assurance: "ADVISORY" | "ENFORCED" }>>>;
  revoke(sessionId: string): Promise<Result<void>>;
}
