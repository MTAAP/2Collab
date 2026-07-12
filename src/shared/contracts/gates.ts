import { z } from "zod";
import { CommitShaSchema, IdentifierSchema, InstantSchema, Sha256Schema } from "./ids.ts";

const boundedText = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }),
  );
const WorkingDirectorySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      value === "." ||
      (!value.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/.test(value) &&
        !value.includes("\\") &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")),
  );

export const LocalProjectGateSchema = z
  .object({
    key: IdentifierSchema,
    kind: z.literal("LOCAL_COMMAND"),
    executable: boundedText,
    arguments: z.array(boundedText).max(64),
    workingDirectory: WorkingDirectorySchema,
    timeoutMs: z.number().int().min(1).max(3_600_000),
    maxOutputBytes: z.number().int().min(1).max(1_048_576),
  })
  .strict();
export const GitHubProjectGateSchema = z
  .object({
    key: IdentifierSchema,
    kind: z.literal("GITHUB_CHECK"),
    checkName: z.string().min(1).max(256),
    acceptableConclusions: z
      .array(z.enum(["SUCCESS", "NEUTRAL", "SKIPPED"]))
      .min(1)
      .max(3),
  })
  .strict();
export const ProjectGateSchema = z.discriminatedUnion("kind", [
  LocalProjectGateSchema,
  GitHubProjectGateSchema,
]);
export type ProjectGate = Readonly<z.infer<typeof ProjectGateSchema>>;

export const GateManifestSchema = z
  .object({
    version: z.literal(1),
    gates: z.array(ProjectGateSchema).min(1).max(128),
    sets: z
      .array(
        z
          .object({ name: IdentifierSchema, gateKeys: z.array(IdentifierSchema).min(1).max(128) })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    const gateKeys = new Set<string>();
    for (const [index, gate] of manifest.gates.entries()) {
      if (gateKeys.has(gate.key))
        context.addIssue({
          code: "custom",
          path: ["gates", index, "key"],
          message: "Duplicate gate key",
        });
      gateKeys.add(gate.key);
      if (gate.kind === "LOCAL_COMMAND") {
        const executable = gate.executable.split(/[\\/]/).at(-1)?.toLowerCase();
        if (
          [
            "sh",
            "bash",
            "zsh",
            "fish",
            "cmd",
            "cmd.exe",
            "powershell",
            "powershell.exe",
            "pwsh",
            "pwsh.exe",
          ].includes(executable ?? "")
        )
          context.addIssue({
            code: "custom",
            path: ["gates", index, "executable"],
            message: "Shell executables are not allowed",
          });
      }
    }
    const setNames = new Set<string>();
    for (const [index, set] of manifest.sets.entries()) {
      if (setNames.has(set.name))
        context.addIssue({
          code: "custom",
          path: ["sets", index, "name"],
          message: "Duplicate set name",
        });
      setNames.add(set.name);
      if (new Set(set.gateKeys).size !== set.gateKeys.length)
        context.addIssue({
          code: "custom",
          path: ["sets", index, "gateKeys"],
          message: "Duplicate set gate",
        });
      if (set.gateKeys.some((key) => !gateKeys.has(key)))
        context.addIssue({
          code: "custom",
          path: ["sets", index, "gateKeys"],
          message: "Unknown gate key",
        });
    }
  });
export type GateManifest = Readonly<z.infer<typeof GateManifestSchema>>;

export const GateManifestSummarySchema = z
  .object({
    version: z.literal(1),
    fingerprint: Sha256Schema,
    gateKeys: z.array(IdentifierSchema).max(128),
    gates: z
      .array(
        z
          .object({
            key: IdentifierSchema,
            kind: z.enum(["LOCAL_COMMAND", "GITHUB_CHECK"]),
            timeoutMs: z.number().int().positive().optional(),
            available: z.boolean(),
          })
          .strict(),
      )
      .max(128),
    sets: z
      .array(
        z.object({ name: IdentifierSchema, gateKeys: z.array(IdentifierSchema).max(128) }).strict(),
      )
      .max(64),
  })
  .strict();
export type GateManifestSummary = Readonly<z.infer<typeof GateManifestSummarySchema>>;

export const GateEvaluationStateSchema = z.enum([
  "PENDING",
  "RUNNING",
  "PASSED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "STALE",
]);
export type GateEvaluationState = z.infer<typeof GateEvaluationStateSchema>;
export const GateEvaluationSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    repositoryRevision: CommitShaSchema,
    gateKey: IdentifierSchema,
    manifestFingerprint: Sha256Schema,
    kind: z.enum(["LOCAL_COMMAND", "GITHUB_CHECK"]),
    state: GateEvaluationStateSchema,
    createdAt: InstantSchema,
    completedAt: InstantSchema.optional(),
  })
  .strict();
export type GateEvaluation = Readonly<z.infer<typeof GateEvaluationSchema>>;

export const LocalGateEvidenceSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255).nullable(),
    durationMs: z.number().int().nonnegative().max(3_600_000),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    trackedMutation: z.boolean(),
    outputDigest: Sha256Schema,
  })
  .strict()
  .refine((value) => !(value.timedOut && value.cancelled));
export type LocalGateEvidence = Readonly<z.infer<typeof LocalGateEvidenceSchema>>;

export type ApprovedGateManifest = Readonly<{
  projectId: string;
  baseRevision: string;
  fingerprint: string;
  approvedByRunnerOwnerId: string;
  approvedAt: number;
  revokedAt?: number;
}>;
