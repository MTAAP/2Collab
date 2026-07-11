import { basename, isAbsolute } from "node:path";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  ExecutionAdapter,
  NormalizedRuntimeEvent,
  PreparedExecution,
  PreparedExecutionRequest,
  RuntimeAdapter,
  RuntimeOutputEvent,
} from "./contract.ts";

const RESERVED_ARGUMENTS = new Set([
  "--cwd",
  "--workdir",
  "--working-directory",
  "--output-format",
  "--json",
  "--prompt",
  "-C",
]);

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function boundedText(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\0") &&
    !/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function validArguments(arguments_: readonly string[]): boolean {
  if (arguments_.length > 64) return false;
  let total = 0;
  for (const argument of arguments_) {
    total += Buffer.byteLength(argument, "utf8");
    if (!boundedText(argument, 4_096) || total > 32_768) return false;
    const key = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (RESERVED_ARGUMENTS.has(key)) return false;
  }
  return true;
}

function normalizeStructured(value: unknown): Result<NormalizedRuntimeEvent> {
  if (typeof value !== "object" || value === null) {
    return failure("RUNTIME_OUTPUT_INVALID", "Runtime output is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !["CONTINUE", "GOAL_ACHIEVED", "ESCALATE"].includes(String(candidate.outcome)) ||
    typeof candidate.reason !== "string" ||
    !boundedText(candidate.reason, 2_048) ||
    !Array.isArray(candidate.evidenceReferences) ||
    candidate.evidenceReferences.length > 32 ||
    !candidate.evidenceReferences.every(
      (reference) =>
        typeof reference === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reference),
    ) ||
    !Object.keys(candidate).every((key) =>
      ["outcome", "reason", "evidenceReferences"].includes(key),
    )
  ) {
    return failure("RUNTIME_OUTPUT_INVALID", "Runtime output is invalid.");
  }
  return {
    ok: true,
    value: {
      kind: "AGENT_OUTCOME",
      outcome: candidate.outcome as "CONTINUE" | "GOAL_ACHIEVED" | "ESCALATE",
      reason: candidate.reason,
      evidenceReferences: candidate.evidenceReferences as string[],
    },
  };
}

export function createBundledExecutionAdapter(
  runtime: RuntimeAdapter,
  executableName: string,
): ExecutionAdapter {
  return {
    runtime,
    async prepare(request: PreparedExecutionRequest): Promise<Result<PreparedExecution>> {
      if (
        request.profile.adapter !== runtime ||
        !isAbsolute(request.profile.executable) ||
        basename(request.profile.executable) !== executableName
      ) {
        return failure("PROFILE_UNAVAILABLE", "Execution profile is unavailable.");
      }
      if (request.profile.fingerprint !== request.expectedFingerprint) {
        return failure("PROFILE_VERSION_MISMATCH", "Execution profile version changed.");
      }
      if (!request.profile.supportedInteractions.includes(request.interaction)) {
        return failure("CAPABILITY_UNSUPPORTED", "Execution interaction is unsupported.");
      }
      if (!validArguments(request.profile.fixedArguments)) {
        return failure("PROFILE_POLICY_DENIED", "Execution profile policy is invalid.");
      }
      if (
        !boundedText(request.instructions, 64 * 1024) ||
        !Number.isSafeInteger(request.maximumRuntimeSeconds) ||
        request.maximumRuntimeSeconds < 1 ||
        request.maximumRuntimeSeconds > 7 * 24 * 60 * 60
      ) {
        return failure("CAPABILITY_UNSUPPORTED", "Execution request is unsupported.");
      }
      const transport =
        request.interaction === "HEADLESS"
          ? request.profile.promptTransport.headless
          : request.profile.promptTransport.interactive;
      const argv = [request.profile.executable, ...request.profile.fixedArguments];
      if (transport === "ARGUMENT") {
        if (Buffer.byteLength(request.instructions, "utf8") > 16 * 1024) {
          return failure("CAPABILITY_UNSUPPORTED", "Execution request is unsupported.");
        }
        argv.push(request.instructions);
      }
      return {
        ok: true,
        value: {
          runtime,
          profileVersionId: request.profileVersionId,
          profileFingerprint: request.profile.fingerprint,
          invocation: { argv },
          prompt: { transport, text: request.instructions },
          interaction: request.interaction,
          outputProtocol: "TEXT_AND_STRUCTURED_EVENTS",
          requirements: { maximumRuntimeSeconds: request.maximumRuntimeSeconds },
        },
      };
    },

    normalize(event: RuntimeOutputEvent): Result<NormalizedRuntimeEvent> {
      if (event.kind === "STDOUT" || event.kind === "STDERR") {
        return boundedText(event.text, 16 * 1024)
          ? { ok: true, value: { kind: "OUTPUT", stream: event.kind, text: event.text } }
          : failure("RUNTIME_OUTPUT_INVALID", "Runtime output is invalid.");
      }
      if (event.kind === "EXIT") {
        if (
          (event.exitCode !== null &&
            (!Number.isSafeInteger(event.exitCode) ||
              event.exitCode < 0 ||
              event.exitCode > 255)) ||
          (event.signal !== null && !/^[A-Z][A-Z0-9]{0,31}$/.test(event.signal))
        ) {
          return failure("RUNTIME_OUTPUT_INVALID", "Runtime output is invalid.");
        }
        return {
          ok: true,
          value: { kind: "PROCESS_EXIT", exitCode: event.exitCode, signal: event.signal },
        };
      }
      return normalizeStructured(event.value);
    },
  };
}
