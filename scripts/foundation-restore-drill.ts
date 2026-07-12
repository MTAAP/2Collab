export type RestorePlanInput = Readonly<{
  project: string;
  dataVolumeExists: boolean;
  apply?: boolean;
  sourceBackupSha256?: string;
  copiedBackupSha256?: string;
  copiedBackupPath?: string;
  masterKeyPath?: string;
  publishedPorts?: readonly string[];
  sharedDataOrBackupPath?: boolean;
}>;

export type RestorePlan =
  | Readonly<{ ok: false; code: "RESTORE_TARGET_UNSAFE" | "RESTORE_INPUT_INVALID" }>
  | Readonly<{
      ok: true;
      mode: "DRY_RUN" | "APPLY";
      listeners: "DISABLED";
      project: string;
      cleanupLabel: string;
      commands: readonly (readonly string[])[];
    }>;

export function planFoundationRestore(input: RestorePlanInput): RestorePlan {
  const safeProject = /^foundation-restore-[a-z0-9-]{8,64}$/.test(input.project);
  if (
    !safeProject ||
    input.project === "2collab" ||
    input.dataVolumeExists ||
    input.sharedDataOrBackupPath ||
    (input.publishedPorts?.length ?? 0) > 0
  )
    return { ok: false, code: "RESTORE_TARGET_UNSAFE" };
  if (
    input.apply &&
    (!input.copiedBackupPath ||
      !input.masterKeyPath ||
      !input.sourceBackupSha256 ||
      input.sourceBackupSha256 !== input.copiedBackupSha256)
  )
    return { ok: false, code: "RESTORE_INPUT_INVALID" };
  return {
    ok: true,
    mode: input.apply ? "APPLY" : "DRY_RUN",
    listeners: "DISABLED",
    project: input.project,
    cleanupLabel: `org.2collab.restore-drill=${input.project}`,
    commands: input.apply
      ? [
          ["collab-server", "restore", "verify"],
          ["collab-server", "restore", "apply"],
          ["collab-server", "restore", "inspect-authority"],
        ]
      : [
          ["collab-server", "restore", "verify"],
          ["collab-server", "restore", "apply"],
        ],
  };
}

if (import.meta.main) {
  const apply = Bun.argv.includes("--apply");
  const value = (name: string): string | undefined => {
    const index = Bun.argv.indexOf(name);
    return index >= 0 ? Bun.argv[index + 1] : undefined;
  };
  const result = planFoundationRestore({
    project: value("--project") ?? "",
    dataVolumeExists: Bun.argv.includes("--existing-data-volume"),
    apply,
    sourceBackupSha256: value("--source-sha256"),
    copiedBackupSha256: value("--copied-sha256"),
    copiedBackupPath: value("--copied-backup"),
    masterKeyPath: value("--master-key-file"),
    publishedPorts: Bun.argv.includes("--published-port") ? [value("--published-port") ?? ""] : [],
    sharedDataOrBackupPath: Bun.argv.includes("--shared-path"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
