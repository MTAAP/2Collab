# Bounded Automation Evidence Ledger

Local fixtures and live provider-backed evidence are separate proof classes. A local result cannot change a live row to `PASS`.

| Requirement | Proof class | Status | Required evidence |
|---|---|---|---|
| AUT-001–AUT-013 | LOCAL | LOCAL_PROOF_AVAILABLE | Historical scoped results exist, but no clean-build evidence envelope and reviewed test-report provenance are attached yet |
| AUT-014 local safety paths | LOCAL | LOCAL_PROOF_AVAILABLE | Fixture and UI paths exercise local behavior; React toggles and fixture journeys are not runtime proof |
| AUT-014 canonical dogfood | LIVE | IN_PROGRESS_EXTERNAL | Approved disposable PR URL, exact head SHA, live Claude and Codex Run IDs, template/preset/workflow IDs, gate/result IDs, and sanitized audit IDs remain required |

## Canonical Product Spec exit criterion

> Exit when the team dogfoods **Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal** on a real pull request with different runtimes or models per step; validation catches missing terminal and fix paths; restart and duplicate events create no duplicate run; pause and waiting do not extend the deadline; and no process remains parked for a human decision.

## Historical local run (not promoted evidence)

Build: `7989025`

```bash
bun test tests/unit/workflows tests/unit/gates tests/integration/workflows tests/integration/gates tests/integration/db/workflows-migration.test.ts tests/integration/db/workflow-execution-migration.test.ts tests/protocol/workflow-authoring-parity.test.ts tests/runner/gates tests/drills/workflow-deadline.test.ts tests/drills/workflow-duplicate-events.test.ts tests/drills/workflow-restart.test.ts tests/drills/workflow-no-parked-process.test.ts
bun run build
bun run test:e2e:run -- workflow-authoring.spec.ts planning-workflow.spec.ts bounded-automation.spec.ts
bun run audit:public
```

Results captured on 2026-07-11:

- 70 tests passed across 31 scoped files; zero failed.
- The web, server, and compiled CLI production builds passed.
- Four Chromium journeys passed.
- The public audit passed for 546 regular files.
- No live provider mutation was authorized or executed.

The repository-wide test command also ran during this implementation wave: 570 tests passed and six inherited migration-version assertions failed because they still cap the registered schema at version 7 while this branch inherits registered versions 8 and 9. Those failures are not counted as local Automation proof. `manifest:verify` remains an integration gate because the inherited release manifest does not yet inventory either the GitHub slice or this Automation slice.

## Status rules

- `LOCAL_PROOF_AVAILABLE` means a named test exists or a historical result was recorded; it is not accepted evidence until a clean-build envelope, report digest, and review provenance bind it to the frozen build.
- `LIVE PASS` requires the named disposable-resource journey to run with explicit authority.
- `BLOCKED` is not `SKIPPED` and is never inferred as success.
- Strict fixtures, mocks, screenshots, or a healthy build cannot satisfy a live row.

No live provider mutation was authorized or executed for this ledger revision.
