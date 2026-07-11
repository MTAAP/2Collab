import type { Result } from "../shared/contracts/result.ts";
import type { CustomLaunchProfile } from "./execution-contract.ts";

export interface LocalEnvironmentCredentialStore {
  resolve(reference: string): string | undefined;
}

type Dependencies = Readonly<{
  base: Readonly<{ HOME: string; PATH: string; TMPDIR?: string; LANG?: string; LC_ALL?: string }>;
  allowedNames: readonly string[];
  credentials: LocalEnvironmentCredentialStore;
}>;

function denied(): Result<never> {
  return {
    ok: false,
    error: {
      code: "ENVIRONMENT_POLICY_DENIED",
      message: "Execution environment policy denied the profile.",
      retry: "NEVER",
    },
  };
}

function safeValue(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= 4_096 &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

export function createRunnerEnvironmentBuilder(dependencies: Dependencies) {
  const protectedNames = new Set(["HOME", "PATH", "TMPDIR"]);
  const allowed = new Set(dependencies.allowedNames);
  if (
    !safeValue(dependencies.base.HOME) ||
    !safeValue(dependencies.base.PATH) ||
    [...allowed].some((name) => protectedNames.has(name) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) ||
    Object.values(dependencies.base).some((value) => value !== undefined && !safeValue(value))
  ) {
    throw new Error("RUNNER_ENVIRONMENT_CONFIGURATION_INVALID");
  }

  return {
    build(profile: CustomLaunchProfile): Result<Readonly<Record<string, string>>> {
      const environment: Record<string, string> = { ...dependencies.base };
      const names = new Set<string>();
      for (const binding of profile.environment ?? []) {
        if (
          protectedNames.has(binding.name) ||
          !allowed.has(binding.name) ||
          names.has(binding.name)
        ) {
          return denied();
        }
        names.add(binding.name);
        const value =
          binding.source === "LITERAL"
            ? binding.value
            : dependencies.credentials.resolve(binding.reference);
        if (value === undefined || !safeValue(value)) return denied();
        environment[binding.name] = value;
      }
      return { ok: true, value: environment };
    },
  };
}
