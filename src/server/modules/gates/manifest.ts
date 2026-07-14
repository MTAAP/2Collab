import type { Result } from "../../../shared/contracts/result.ts";
import {
  GateManifestSchema,
  type GateManifest,
  type GateManifestSummary,
} from "../../../shared/contracts/gates.ts";
import { fingerprintGateManifest } from "./fingerprints.ts";

const MAX_MANIFEST_BYTES = 64 * 1024;
const failure = (
  code: "GATE_MANIFEST_UNTRUSTED" | "GATE_MANIFEST_INVALID",
  message: string,
): Result<never> => ({ ok: false, error: { code, message, retry: "NEVER" } });

function normalize(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const gates = Array.isArray(value.gates)
    ? value.gates.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
          return candidate;
        const gate = candidate as Record<string, unknown>;
        return gate.kind === "LOCAL_COMMAND"
          ? {
              key: gate.key,
              kind: gate.kind,
              executable: gate.executable,
              arguments: gate.arguments,
              workingDirectory: gate.working_directory,
              timeoutMs: gate.timeout_ms,
              maxOutputBytes: gate.max_output_bytes,
            }
          : {
              key: gate.key,
              kind: gate.kind,
              checkName: gate.check_name,
              acceptableConclusions: gate.acceptable_conclusions,
            };
      })
    : value.gates;
  const sets =
    value.sets && typeof value.sets === "object" && !Array.isArray(value.sets)
      ? Object.entries(value.sets as Record<string, unknown>).map(([name, gateKeys]) => ({
          name,
          gateKeys,
        }))
      : value.sets;
  return { version: value.version, gates, sets };
}

export function summarizeGateManifest(manifest: GateManifest): GateManifestSummary {
  return {
    version: 1,
    fingerprint: fingerprintGateManifest(manifest),
    gateKeys: manifest.gates.map((gate) => gate.key),
    gates: manifest.gates.map((gate) => ({
      key: gate.key,
      kind: gate.kind,
      ...(gate.kind === "LOCAL_COMMAND" ? { timeoutMs: gate.timeoutMs } : {}),
      available: true,
    })),
    sets: manifest.sets.map((set) => ({ name: set.name, gateKeys: [...set.gateKeys] })),
  };
}

export function parseTrustedGateManifest(
  input: Readonly<{ source: string; manifestRevision: string; trustedBaseRevision: string }>,
): Result<Readonly<{ manifest: GateManifest; summary: GateManifestSummary }>> {
  if (input.manifestRevision !== input.trustedBaseRevision)
    return failure(
      "GATE_MANIFEST_UNTRUSTED",
      "Gate manifest is not from the trusted base revision.",
    );
  if (Buffer.byteLength(input.source, "utf8") > MAX_MANIFEST_BYTES || input.source.includes("\0"))
    return failure("GATE_MANIFEST_INVALID", "Gate manifest is invalid.");
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(input.source);
  } catch {
    return failure("GATE_MANIFEST_INVALID", "Gate manifest is invalid.");
  }
  const parsed = GateManifestSchema.safeParse(normalize(raw));
  if (!parsed.success) return failure("GATE_MANIFEST_INVALID", "Gate manifest is invalid.");
  return {
    ok: true,
    value: { manifest: parsed.data, summary: summarizeGateManifest(parsed.data) },
  };
}
