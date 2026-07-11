import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkFoundationExit,
  createEmptyFoundationEvidence,
  DogfoodDaySchema,
  FoundationEvidenceSchema,
  MachineEnrollmentSchema,
  MachineRunEvidenceSchema,
  RestoreEvidenceSchema,
  validateEvidence,
  type FoundationEvidence,
} from "./evidence/foundation-contract.ts";

const DEFAULT_PATH = "docs/evidence/foundation/live-evidence.json";

export class FoundationEvidenceService {
  constructor(
    private readonly path = DEFAULT_PATH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async read(): Promise<FoundationEvidence> {
    return FoundationEvidenceSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
  }

  private async write(evidence: FoundationEvidence): Promise<void> {
    await writeFile(
      this.path,
      `${JSON.stringify(FoundationEvidenceSchema.parse(evidence), null, 2)}\n`,
      { flag: "wx" },
    );
  }

  private async replace(evidence: FoundationEvidence): Promise<void> {
    await writeFile(
      this.path,
      `${JSON.stringify(FoundationEvidenceSchema.parse(evidence), null, 2)}\n`,
    );
  }

  async init(input: Parameters<typeof createEmptyFoundationEvidence>[0]): Promise<void> {
    await this.write(
      createEmptyFoundationEvidence({ ...input, initializedAt: this.now().toISOString() }),
    );
  }

  async enrollMachine(input: unknown): Promise<void> {
    const evidence = await this.read();
    const row = MachineEnrollmentSchema.parse(input);
    if (evidence.machines.some((item) => item.evidenceId === row.evidenceId))
      throw new Error("EVIDENCE_ID_DUPLICATE");
    await this.replace({ ...evidence, machines: [...evidence.machines, row] });
  }

  async recordRun(input: unknown): Promise<void> {
    const evidence = await this.read();
    const row = MachineRunEvidenceSchema.parse(input);
    if (evidence.runs.some((item) => item.evidenceId === row.evidenceId))
      throw new Error("EVIDENCE_ID_DUPLICATE");
    await this.replace({ ...evidence, runs: [...evidence.runs, row] });
  }

  async recordRestore(input: unknown): Promise<void> {
    const evidence = await this.read();
    const row = RestoreEvidenceSchema.parse(input);
    if (evidence.restores.some((item) => item.evidenceId === row.evidenceId))
      throw new Error("EVIDENCE_ID_DUPLICATE");
    await this.replace({ ...evidence, restores: [...evidence.restores, row] });
  }

  async closeDay(
    input: Omit<Parameters<typeof DogfoodDaySchema.parse>[0], "localDate" | "recordedAt">,
  ): Promise<void> {
    const evidence = await this.read();
    const instant = this.now();
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: evidence.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
    const row = DogfoodDaySchema.parse({
      ...(input as object),
      localDate,
      recordedAt: instant.toISOString(),
    });
    if (evidence.days.some((day) => day.localDate === localDate))
      throw new Error("DOGFOOD_DATE_DUPLICATE");
    const lastDate = evidence.days.at(-1)?.localDate;
    if (lastDate && lastDate >= localDate) throw new Error("DOGFOOD_DATE_OUT_OF_ORDER");
    await this.replace({ ...evidence, days: [...evidence.days, row] });
  }

  async validate(): Promise<ReturnType<typeof validateEvidence>> {
    return validateEvidence(await this.read());
  }
  async checkExit(): Promise<ReturnType<typeof checkFoundationExit>> {
    return checkFoundationExit(await this.read());
  }
  async status(): Promise<{
    validation: ReturnType<typeof validateEvidence>;
    exit: ReturnType<typeof checkFoundationExit>;
  }> {
    const evidence = await this.read();
    return { validation: validateEvidence(evidence), exit: checkFoundationExit(evidence) };
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
function option(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

export async function runFoundationEvidenceCli(): Promise<number> {
  const command = Bun.argv[2];
  const service = new FoundationEvidenceService(resolve(option("--evidence") ?? DEFAULT_PATH));
  try {
    if (command === "init") {
      await service.init({
        buildId: option("--build-id") ?? "",
        artifactManifestSha256: option("--artifact-manifest-sha256") ?? "",
        repositoryCommit: option("--repository-commit") ?? "",
        timezone: option("--timezone") ?? "UTC",
      });
      console.log(JSON.stringify({ status: "IN_PROGRESS_EXTERNAL" }));
      return 0;
    }
    if (["enroll-machine", "record-run", "record-restore", "close-day"].includes(command ?? "")) {
      const inputPath = option("--input");
      if (!inputPath) throw new Error("EVIDENCE_INPUT_REQUIRED");
      const input = await readJson(inputPath);
      if (command === "enroll-machine") await service.enrollMachine(input);
      else if (command === "record-run") await service.recordRun(input);
      else if (command === "record-restore") await service.recordRestore(input);
      else await service.closeDay(input as never);
      console.log(JSON.stringify(await service.status()));
      return 0;
    }
    if (command === "validate") {
      console.log(JSON.stringify(await service.validate()));
      return 0;
    }
    if (command === "status") {
      console.log(JSON.stringify(await service.status()));
      return 0;
    }
    if (command === "check-exit") {
      const result = await service.checkExit();
      console.log(JSON.stringify(result));
      return result.ok ? 0 : 2;
    }
    throw new Error("EVIDENCE_COMMAND_INVALID");
  } catch (error) {
    console.error(
      JSON.stringify({
        code: error instanceof Error ? error.message.slice(0, 120) : "EVIDENCE_OPERATION_FAILED",
      }),
    );
    return 1;
  }
}

if (import.meta.main) process.exit(await runFoundationEvidenceCli());
