# Foundation Evidence Operator Runbook

This repository currently provides evidence machinery. It does not contain authentic two-machine, copied-restore, or seven-day observations.

## Freeze and initialize a build

Run the full local gate, create a tested-build artifact manifest outside the source inventory, and record its SHA-256. Initialize once:

```bash
bun run scripts/foundation-evidence.ts init --build-id <immutable-build-id> --artifact-manifest-sha256 <sha256> --repository-commit <full-sha> --timezone Europe/Berlin
```

Do not change the frozen build after day one. Build changes begin a new evidence period.

## Machine matrix

Enroll exactly two owners on two trusted machines with reviewed JSON input. An enrollment without authenticated reviewer provenance remains structurally recordable but cannot count toward exit. Then record Claude and Codex through Native and Orca in HEADLESS and INTERACTIVE mode. Every owner must demonstrate both Web and CLI launch surfaces. Interactive keystrokes and terminal bytes stay local.

```bash
bun run scripts/foundation-evidence.ts enroll-machine --input <reviewed-json>
bun run scripts/foundation-evidence.ts record-run --input <reviewed-json>
```

Run `collab doctor` and `collab runner status` before each machine session. No fallback host, runtime, profile, or interaction substitution may be recorded as the intended tuple.

## Copied restore

The restore planner defaults to dry-run. Use a separately copied encrypted backup, matching source and destination SHA-256, a separately mounted master-key file, and a brand-new generated Compose project. Never use the production project, a live or existing volume, shared data/backup paths, or published ports before verification.

```bash
bun run scripts/foundation-restore-drill.ts --project foundation-restore-<random>
bun run scripts/foundation-restore-drill.ts --apply --project foundation-restore-<random> --copied-backup <path> --master-key-file <path> --source-sha256 <sha256> --copied-sha256 <sha256>
```

Review the offline verify/apply results and authority-invalidation proof before recording the row. Cleanup only resources bearing the generated drill label.

## Close a day

`close-day` derives the local date from the locked timezone and trusted operator clock. It accepts no date argument. Record runs, incidents or `NONE`, migrations/restarts or `NONE`, backup result, current restore evidence reference, direct-repair result, and authenticated review. A row with `reviewed: true` is invalid without reviewer identity and review time. An accepted day must reference an active, reviewed, fully passing copied-restore record from the same frozen build.

```bash
bun run scripts/foundation-evidence.ts close-day --input <reviewed-json>
```

Corrections never edit or replace the original row. `correct-day` derives the original calendar date from `correctionOf`, appends a new evidence ID, and supersedes exactly one active row. Unknown, cross-date, duplicate, and branching correction chains are rejected.

```bash
bun run scripts/foundation-evidence.ts correct-day --input <reviewed-correction-json>
```

## Validate

```bash
bun run evidence:validate
bun run evidence:foundation-exit
```

Validation must pass for a structurally consistent pending ledger. The exit command must remain nonzero with `FOUNDATION_EXIT_NOT_MET` until all authentic obligations are complete.

Never include secrets, environment values, raw arguments, transcripts, terminal content, provider URLs, private paths, or manually asserted aggregate `PASS` values in evidence input or commits.
