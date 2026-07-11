# Foundation Evidence Template

- Schema version: 1
- Package status: NOT_RUN
- Foundation status: NOT_STARTED
- Canonical exit criterion: NOT_EVALUATED
- Human reviewer: UNREVIEWED

## Required values

- Per-command result: `NOT_RUN | PASS | FAIL | BLOCKED_ENV`
- Per-requirement status: `NOT_STARTED | IN_PROGRESS_LOCAL | LOCAL_PROOF_COMPLETE | IN_PROGRESS_EXTERNAL | PASS | FAIL`
- Artifact identity: tested repository commit, dirty-tree state, build identifier, Bun version, platform, architecture, `bun.lock` digest, tested-build artifact-manifest digest, compiled `collab` digest, and server artifact or image digest
- Timing: UTC start, UTC end, and duration for every command
- Proof: requirement ID, obligation ID, exact command, exit code, result, safe audit/event/run IDs or `MISSING`, reviewer state, limitations, and external/live status
- Review integrity: machine enrollment requires reviewer provenance to count; a reviewed day requires reviewer provenance; an accepted day references an active reviewed fully passing restore from the same frozen build
- Correction integrity: corrections are append-only unique records that supersede exactly one active same-date record; branching, unknown, duplicate, or cross-date correction references are invalid

Direct SQLite repair means any manual statement or file edit that changes authoritative database contents outside shipped migrations, restore, or supported commands.

Do not record raw output, credentials, environment values, source or document bodies, flattened prompts, diffs, provider URLs, private paths, transcripts, or private runner/profile details.
