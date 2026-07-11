import type { Result } from "../../../shared/contracts/result.ts";

export type RuntimeAdapter = "CLAUDE" | "CODEX";
export type InteractionMode = "HEADLESS" | "INTERACTIVE";
export type PromptTransport = "STDIN" | "ARGUMENT" | "TERMINAL_INPUT";

export type CustomLaunchProfile = Readonly<{
  adapter: RuntimeAdapter;
  executable: string;
  fixedArguments: readonly string[];
  promptTransport: Readonly<{
    headless: "STDIN" | "ARGUMENT";
    interactive: "TERMINAL_INPUT" | "ARGUMENT";
  }>;
  supportedInteractions: readonly InteractionMode[];
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
