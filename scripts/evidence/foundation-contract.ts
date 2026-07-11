import { z } from "zod";
import { PHASE_EXIT_QUOTES, validateEvidenceEnvelope } from "./evidence-envelope.ts";

const OpaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const UtcInstant = z.string().datetime({ offset: true });
const Reviewer = z.object({ memberId: OpaqueId, reviewedAt: UtcInstant }).strict();

export const ExternalResultSchema = z.enum(["NOT_RUN", "PASS", "FAIL", "BLOCKED_ENV"]);

export const FrozenBuildSchema = z
  .object({
    buildId: OpaqueId,
    artifactManifestSha256: Sha256,
    repositoryCommit: Commit,
  })
  .strict();

export const MachineEnrollmentSchema = z
  .object({
    evidenceId: OpaqueId,
    ownerId: OpaqueId,
    machineId: OpaqueId,
    runnerId: OpaqueId,
    generation: z.number().int().positive(),
    enrolledAt: UtcInstant,
    reviewer: Reviewer.optional(),
  })
  .strict();

export const MachineRunEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: OpaqueId,
    buildId: OpaqueId,
    artifactManifestSha256: Sha256,
    ownerId: OpaqueId,
    machineId: OpaqueId,
    machineGeneration: z.number().int().positive(),
    runnerId: OpaqueId,
    runId: OpaqueId,
    attemptId: OpaqueId,
    runnerEpoch: z.number().int().positive(),
    policyRevision: z.number().int().positive(),
    mappingRevision: z.number().int().positive(),
    profileRevision: z.number().int().positive(),
    profileFingerprint: Sha256,
    runtime: z.enum(["CLAUDE", "CODEX"]),
    host: z.enum(["NATIVE", "ORCA"]),
    mode: z.enum(["HEADLESS", "INTERACTIVE"]),
    launchSurface: z.enum(["WEB", "CLI"]),
    startedAt: UtcInstant,
    terminalAt: UtcInstant,
    attemptLifecycle: z.enum(["EXITED", "FAILED_TO_START", "CANCELLED", "TIMED_OUT", "LOST"]),
    runResult: z.enum(["DELIVERED", "NO_CHANGES", "BLOCKED", "ESCALATED"]),
    hostAdapterProvenance: z.enum(["NATIVE_ADAPTER", "ORCA_ADAPTER"]),
    interactiveLocalPresence: z.enum(["NOT_APPLICABLE", "PASS", "FAIL"]),
    sharedTransportPrivacy: z.enum(["PASS", "FAIL"]),
    result: ExternalResultSchema,
    reviewer: Reviewer.optional(),
    notes: z.string().max(240).optional(),
    correctionOf: OpaqueId.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (Date.parse(row.terminalAt) < Date.parse(row.startedAt))
      context.addIssue({ code: "custom", message: "terminalAt precedes startedAt" });
    if (row.hostAdapterProvenance !== `${row.host}_ADAPTER`)
      context.addIssue({ code: "custom", message: "host provenance mismatch" });
    if (row.mode === "INTERACTIVE" && row.interactiveLocalPresence === "NOT_APPLICABLE")
      context.addIssue({ code: "custom", message: "interactive local presence is required" });
    if (row.mode === "HEADLESS" && row.interactiveLocalPresence !== "NOT_APPLICABLE")
      context.addIssue({
        code: "custom",
        message: "headless local presence must be NOT_APPLICABLE",
      });
  });

export const RestoreEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: OpaqueId,
    buildId: OpaqueId,
    copiedBackupSha256: Sha256,
    sourceBackupSha256: Sha256,
    keyId: OpaqueId,
    isolatedProject: z.string().regex(/^foundation-restore-[a-z0-9-]{8,64}$/),
    freshAuthorityIncarnation: z.boolean(),
    oldSessionsInvalid: z.boolean(),
    oldCapabilitiesInvalid: z.boolean(),
    oldPermitsInvalid: z.boolean(),
    runnerEpochAdvanced: z.boolean(),
    connectorEpochAdvanced: z.boolean(),
    connectorReviewRequired: z.boolean(),
    listenerDisabledUntilComplete: z.boolean(),
    result: ExternalResultSchema,
    recordedAt: UtcInstant,
    reviewer: Reviewer.optional(),
    notes: z.string().max(240).optional(),
    correctionOf: OpaqueId.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.sourceBackupSha256 !== row.copiedBackupSha256)
      context.addIssue({ code: "custom", message: "copied backup digest mismatch" });
  });

export const DogfoodDaySchema = z
  .object({
    evidenceId: OpaqueId,
    localDate: z.string().date(),
    buildId: OpaqueId,
    completed: z.boolean(),
    reviewed: z.boolean(),
    directDatabaseRepair: z.enum(["NO", "YES"]),
    runIds: z.array(OpaqueId).max(100),
    incidents: z.union([z.literal("NONE"), z.array(OpaqueId).min(1).max(50)]),
    migrationsOrRestarts: z.union([z.literal("NONE"), z.array(OpaqueId).min(1).max(50)]),
    backupResult: z.enum(["PASS", "FAIL", "BLOCKED_ENV", "NOT_RUN"]),
    restoreEvidenceId: OpaqueId,
    recordedAt: UtcInstant,
    reviewer: Reviewer.optional(),
    correctionOf: OpaqueId.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.reviewed !== Boolean(row.reviewer)) {
      context.addIssue({ code: "custom", message: "reviewed state requires reviewer provenance" });
    }
  });

export const FoundationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    frozenBuild: FrozenBuildSchema,
    timezone: z.string().min(1).max(64),
    initializedAt: UtcInstant,
    evidenceEnvelope: z.unknown().optional(),
    machines: z.array(MachineEnrollmentSchema),
    runs: z.array(MachineRunEvidenceSchema),
    restores: z.array(RestoreEvidenceSchema),
    days: z.array(DogfoodDaySchema),
  })
  .strict();

export type FoundationEvidence = z.infer<typeof FoundationEvidenceSchema>;
export type DogfoodDay = z.infer<typeof DogfoodDaySchema>;

type CorrectableEvidence = Readonly<{
  evidenceId: string;
  correctionOf?: string;
}>;

function resolveCorrections<T extends CorrectableEvidence>(rows: readonly T[]): readonly T[] {
  const byId = new Map<string, T>();
  const superseded = new Set<string>();
  for (const row of rows) {
    if (byId.has(row.evidenceId)) throw new Error("EVIDENCE_ID_DUPLICATE");
    if (row.correctionOf) {
      if (!byId.has(row.correctionOf)) throw new Error("EVIDENCE_CORRECTION_TARGET_INVALID");
      if (superseded.has(row.correctionOf)) throw new Error("EVIDENCE_CORRECTION_BRANCH_INVALID");
      superseded.add(row.correctionOf);
    }
    byId.set(row.evidenceId, row);
  }
  return rows.filter((row) => !superseded.has(row.evidenceId));
}

export function resolveEffectiveDogfoodDays(days: readonly DogfoodDay[]): readonly DogfoodDay[] {
  const effective = resolveCorrections(days);
  const activeDates = new Set<string>();
  for (const row of days) {
    if (row.correctionOf) {
      const original = days.find((candidate) => candidate.evidenceId === row.correctionOf);
      if (!original || original.localDate !== row.localDate)
        throw new Error("DOGFOOD_CORRECTION_DATE_INVALID");
    }
  }
  for (const row of effective) {
    if (activeDates.has(row.localDate)) throw new Error("DOGFOOD_DATE_DUPLICATE");
    activeDates.add(row.localDate);
  }
  return [...effective].sort((left, right) => left.localDate.localeCompare(right.localDate));
}

function isAcceptedRestore(row: FoundationEvidence["restores"][number], buildId: string): boolean {
  return (
    row.result === "PASS" &&
    row.reviewer !== undefined &&
    row.buildId === buildId &&
    row.freshAuthorityIncarnation &&
    row.oldSessionsInvalid &&
    row.oldCapabilitiesInvalid &&
    row.oldPermitsInvalid &&
    row.runnerEpochAdvanced &&
    row.connectorEpochAdvanced &&
    row.connectorReviewRequired &&
    row.listenerDisabledUntilComplete
  );
}

export function assertIanaTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("EVIDENCE_TIMEZONE_INVALID");
  }
}

export function createEmptyFoundationEvidence(
  input: z.infer<typeof FrozenBuildSchema> & { timezone: string; initializedAt?: string },
): FoundationEvidence {
  assertIanaTimezone(input.timezone);
  return FoundationEvidenceSchema.parse({
    schemaVersion: 1,
    frozenBuild: {
      buildId: input.buildId,
      artifactManifestSha256: input.artifactManifestSha256,
      repositoryCommit: input.repositoryCommit,
    },
    timezone: input.timezone,
    initializedAt: input.initializedAt ?? new Date().toISOString(),
    machines: [],
    runs: [],
    restores: [],
    days: [],
  });
}

function calendarOrdinal(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined)
    throw new Error("DOGFOOD_DATE_INVALID");
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function deriveConsecutiveDayStreak(
  days: readonly Pick<
    DogfoodDay,
    | "localDate"
    | "buildId"
    | "completed"
    | "reviewed"
    | "directDatabaseRepair"
    | "backupResult"
    | "restoreEvidenceId"
    | "recordedAt"
  >[],
): number {
  let streak = 0;
  let previousOrdinal: number | undefined;
  let buildId: string | undefined;
  for (const day of days) {
    const ordinal = calendarOrdinal(day.localDate);
    const valid =
      day.completed &&
      day.reviewed &&
      day.directDatabaseRepair === "NO" &&
      day.backupResult === "PASS" &&
      day.restoreEvidenceId.length > 0;
    if (
      !valid ||
      (buildId !== undefined && buildId !== day.buildId) ||
      (previousOrdinal !== undefined && ordinal !== previousOrdinal + 1)
    )
      streak = 0;
    if (valid) streak += 1;
    previousOrdinal = ordinal;
    buildId = day.buildId;
  }
  return streak;
}

export function validateEvidence(input: FoundationEvidence): { status: "IN_PROGRESS_EXTERNAL" } {
  const evidence = FoundationEvidenceSchema.parse(input);
  assertIanaTimezone(evidence.timezone);
  if (evidence.evidenceEnvelope) {
    const envelope = validateEvidenceEnvelope(evidence.evidenceEnvelope, {
      phase: "FOUNDATION",
      buildId: evidence.frozenBuild.buildId,
      canonicalExitQuote: PHASE_EXIT_QUOTES.FOUNDATION,
    });
    if (!envelope.valid) throw new Error(envelope.reasons[0] ?? "EVIDENCE_ENVELOPE_INVALID");
    if (envelope.envelope?.repositoryRevision !== evidence.frozenBuild.repositoryCommit)
      throw new Error("EVIDENCE_FROZEN_REVISION_MISMATCH");
    if (envelope.envelope?.artifactSha256 !== evidence.frozenBuild.artifactManifestSha256)
      throw new Error("EVIDENCE_FROZEN_ARTIFACT_MISMATCH");
  }
  const days = resolveEffectiveDogfoodDays(evidence.days);
  const effectiveRestores = resolveCorrections(evidence.restores);
  for (let index = 1; index < evidence.days.length; index += 1) {
    const current = evidence.days[index]?.recordedAt;
    const previous = evidence.days[index - 1]?.recordedAt;
    if (!current || !previous || current <= previous)
      throw new Error("DOGFOOD_RECORD_OUT_OF_ORDER");
  }
  for (const day of days) {
    const accepted =
      day.completed &&
      day.reviewed &&
      Boolean(day.reviewer) &&
      day.directDatabaseRepair === "NO" &&
      day.backupResult === "PASS";
    if (!accepted) continue;
    const restore = effectiveRestores.find(
      (candidate) => candidate.evidenceId === day.restoreEvidenceId,
    );
    if (
      !restore ||
      day.buildId !== evidence.frozenBuild.buildId ||
      !isAcceptedRestore(restore, day.buildId)
    ) {
      throw new Error("DOGFOOD_RESTORE_EVIDENCE_INVALID");
    }
  }
  if (evidence.machines.length > 2) throw new Error("MACHINE_MATRIX_EXCESS_ENROLLMENT");
  return { status: "IN_PROGRESS_EXTERNAL" };
}

function activeMachines(evidence: FoundationEvidence): FoundationEvidence["machines"] {
  const byMachine = new Map<string, FoundationEvidence["machines"][number]>();
  for (const machine of evidence.machines) {
    const current = byMachine.get(machine.machineId);
    if (!current || machine.generation > current.generation)
      byMachine.set(machine.machineId, machine);
  }
  return [...byMachine.values()].filter((machine) => machine.reviewer !== undefined);
}

export function checkFoundationExit(
  evidence: FoundationEvidence,
):
  | { ok: true; code: "FOUNDATION_EXIT_MET" }
  | { ok: false; code: "FOUNDATION_EXIT_NOT_MET"; missing: readonly string[] } {
  validateEvidence(evidence);
  const missing: string[] = [];
  if (!evidence.evidenceEnvelope) missing.push("BUILD_BOUND_EVIDENCE_ENVELOPE");
  const machines = activeMachines(evidence);
  if (machines.length !== 2 || new Set(machines.map((row) => row.ownerId)).size !== 2)
    missing.push("TWO_REVIEWED_OWNERS_AND_MACHINES");
  const accepted = evidence.runs.filter(
    (row) =>
      row.result === "PASS" &&
      row.reviewer &&
      row.sharedTransportPrivacy === "PASS" &&
      (row.mode !== "INTERACTIVE" || row.interactiveLocalPresence === "PASS") &&
      row.buildId === evidence.frozenBuild.buildId &&
      row.artifactManifestSha256 === evidence.frozenBuild.artifactManifestSha256,
  );
  for (const machine of machines) {
    for (const runtime of ["CLAUDE", "CODEX"] as const)
      for (const host of ["NATIVE", "ORCA"] as const)
        for (const mode of ["HEADLESS", "INTERACTIVE"] as const) {
          if (
            !accepted.some(
              (row) =>
                row.ownerId === machine.ownerId &&
                row.machineId === machine.machineId &&
                row.machineGeneration === machine.generation &&
                row.runtime === runtime &&
                row.host === host &&
                row.mode === mode,
            )
          )
            missing.push(`${machine.ownerId}:${runtime}:${host}:${mode}`);
        }
    const surfaces = new Set(
      accepted.filter((row) => row.ownerId === machine.ownerId).map((row) => row.launchSurface),
    );
    if (!surfaces.has("WEB") || !surfaces.has("CLI"))
      missing.push(`${machine.ownerId}:WEB_AND_CLI`);
  }
  const restore = resolveCorrections(evidence.restores).find((row) =>
    isAcceptedRestore(row, evidence.frozenBuild.buildId),
  );
  if (!restore) missing.push("COPIED_ISOLATED_RESTORE");
  if (deriveConsecutiveDayStreak(resolveEffectiveDogfoodDays(evidence.days)) < 7)
    missing.push("SEVEN_CONSECUTIVE_REVIEWED_DAYS");
  return missing.length === 0
    ? { ok: true, code: "FOUNDATION_EXIT_MET" }
    : { ok: false, code: "FOUNDATION_EXIT_NOT_MET", missing };
}
