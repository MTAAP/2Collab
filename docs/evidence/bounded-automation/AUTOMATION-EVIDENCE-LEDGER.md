# Bounded Automation Evidence Ledger

Local fixtures and live provider-backed evidence are separate proof classes. A local result cannot change a live row to `PASS`.

| Requirement | Proof class | Status | Required evidence |
|---|---|---|---|
| AUT-001–AUT-013 | LOCAL | NOT_RUN | Exact command, committed build ID, sanitized test result, and reviewed audit identifiers where applicable |
| AUT-014 local safety paths | LOCAL | NOT_RUN | React Flow authoring, clean and major paths, restart, duplicate event, deadline, and no-parked-process proof |
| AUT-014 canonical dogfood | LIVE | BLOCKED | Approved disposable PR URL, exact head SHA, live Claude and Codex Run IDs, template/preset/workflow IDs, gate/result IDs, and sanitized audit IDs |

## Status rules

- `LOCAL PASS` requires the named command to run against the recorded committed build.
- `LIVE PASS` requires the named disposable-resource journey to run with explicit authority.
- `BLOCKED` is not `SKIPPED` and is never inferred as success.
- Strict fixtures, mocks, screenshots, or a healthy build cannot satisfy a live row.

No live provider mutation was authorized or executed for this ledger revision.
