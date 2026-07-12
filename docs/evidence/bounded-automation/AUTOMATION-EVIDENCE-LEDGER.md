# Bounded Automation Evidence Ledger

Local test execution and live provider-backed proof are separate evidence classes. Source files, historical console summaries, fixtures, UI toggles, and test names do not establish a passed obligation.

| Requirement | Proof class | Status | Current evidence state |
|---|---|---|---|
| AUT-001–AUT-013 | LOCAL | NOT_RUN | The obligation registry is mapped to the canonical Acceptance Matrix, but no clean frozen-build envelope and no digest-bound Bun/Playwright reports are attached |
| AUT-014 local safety paths | LOCAL | NOT_RUN | Fixture journeys exist, but they have no frozen-build report envelope and cannot prove the provider-backed exit |
| AUT-014 canonical dogfood | LIVE | IN_PROGRESS_EXTERNAL | An approved real pull request, exact head SHA, live Claude and Codex Run IDs, template/preset/workflow IDs, gate/result IDs, sanitized audit IDs, and a passed live Playwright report remain required |

## Canonical Product Spec exit criterion

> Exit when the team dogfoods **Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal** on a real pull request with different runtimes or models per step; validation catches missing terminal and fix paths; restart and duplicate events create no duplicate run; pause and waiting do not extend the deadline; and no process remains parked for a human decision.

## Evidence promotion rules

- `LOCAL_PROOF_AVAILABLE` requires every obligation ID for the row to appear as a passed case in a real digest-bound JUnit or Playwright report.
- The report, artifact, lockfile, and manifest files must exist and match the clean frozen-build envelope digests.
- Every canonical test level named by the Acceptance Matrix must be represented by an obligation.
- A local row cannot become `PASS`; live acceptance requires the authorized provider-backed journey and review.
- `BLOCKED_ENV`, `IN_PROGRESS_EXTERNAL`, and `NOT_RUN` are never inferred as success.

No live provider mutation was authorized or executed for this ledger revision.
