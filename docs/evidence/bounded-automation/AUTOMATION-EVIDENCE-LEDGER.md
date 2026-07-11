# Bounded Automation Evidence Ledger

Local fixtures and live provider-backed evidence are separate proof classes. A local result cannot change a live row to `PASS`.

| Requirement | Proof class | Status | Required evidence |
|---|---|---|---|
| AUT-001–AUT-013 | LOCAL | PASS | Build `7989025`; 70 scoped tests passed; production build and public audit passed |
| AUT-014 local safety paths | LOCAL | PASS | Build `7989025`; four Chromium journeys passed, including clean/major routing and explicit live-blocked state; restart, duplicate-event, deadline, and no-parked-process drills passed |
| AUT-014 canonical dogfood | LIVE | BLOCKED | Approved disposable PR URL, exact head SHA, live Claude and Codex Run IDs, template/preset/workflow IDs, gate/result IDs, and sanitized audit IDs |

## Captured local run

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

- `LOCAL PASS` requires the named command to run against the recorded committed build.
- `LIVE PASS` requires the named disposable-resource journey to run with explicit authority.
- `BLOCKED` is not `SKIPPED` and is never inferred as success.
- Strict fixtures, mocks, screenshots, or a healthy build cannot satisfy a live row.

No live provider mutation was authorized or executed for this ledger revision.
