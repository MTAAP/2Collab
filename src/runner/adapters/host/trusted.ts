import type { Result } from "../../../shared/contracts/result.ts";
import type { ExecutionHost, HostProcess, SupervisorLaunch, TrustedHostPort } from "./contract.ts";

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createTrustedExecutionHost(
  host: "NATIVE" | "ORCA",
  port: TrustedHostPort,
): ExecutionHost {
  return {
    host,
    async start(execution: SupervisorLaunch): Promise<Result<HostProcess>> {
      if (execution.assurance !== "ADVISORY") {
        return failure("ASSURANCE_UNAVAILABLE", "Requested repository assurance is unavailable.");
      }
      if (
        execution.invocation.argv.length < 1 ||
        execution.invocation.argv.length > 65 ||
        execution.invocation.argv.some((argument) => argument.includes("\0")) ||
        !Number.isSafeInteger(execution.deadlineAt)
      ) {
        return failure("HOST_LAUNCH_INVALID", "Prepared execution is invalid.");
      }
      try {
        const started = await port.start(execution);
        if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(started.opaqueProcessId)) {
          return failure("HOST_START_FAILED", "Execution host failed to start.");
        }
        return {
          ok: true,
          value: {
            host,
            opaqueProcessId: started.opaqueProcessId,
            interaction: execution.interaction,
            assurance: "ADVISORY",
          },
        };
      } catch {
        return failure("HOST_START_FAILED", "Execution host failed to start.");
      }
    },

    async cancel(process) {
      if (process.host !== host) return failure("HOST_PROCESS_INVALID", "Host process is invalid.");
      try {
        return { ok: true, value: { requested: await port.cancel(process.opaqueProcessId) } };
      } catch {
        return failure("HOST_CANCEL_FAILED", "Execution cancellation failed.");
      }
    },

    async inspect(process) {
      if (process.host !== host) return failure("HOST_PROCESS_INVALID", "Host process is invalid.");
      try {
        return { ok: true, value: { state: await port.inspect(process.opaqueProcessId) } };
      } catch {
        return failure("HOST_INSPECTION_FAILED", "Execution inspection failed.");
      }
    },

    async attach(process) {
      if (process.host !== host || process.interaction !== "INTERACTIVE") {
        return failure("HOST_ATTACHMENT_UNAVAILABLE", "Local attachment is unavailable.");
      }
      try {
        const attachment = await port.attach(process.opaqueProcessId);
        return /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(attachment.localAttachmentId)
          ? { ok: true, value: attachment }
          : failure("HOST_ATTACHMENT_UNAVAILABLE", "Local attachment is unavailable.");
      } catch {
        return failure("HOST_ATTACHMENT_UNAVAILABLE", "Local attachment is unavailable.");
      }
    },
  };
}
