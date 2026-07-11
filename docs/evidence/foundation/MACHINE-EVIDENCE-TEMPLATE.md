# Machine Evidence Template

> Exit when both owners can start headless and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server backup and isolated restore drills pass; and one week of dogfood produces no need for direct database repair.

Create a strict JSON row accepted by `MachineEnrollmentSchema` or `MachineRunEvidenceSchema` in `scripts/evidence/foundation-contract.ts`.

Record only opaque IDs; frozen build and artifact IDs; runner epoch; policy, mapping, and profile revisions; safe profile fingerprint; runtime; host; mode; Web or CLI launch surface; UTC lifecycle times; canonical attempt lifecycle (`EXITED`, `FAILED_TO_START`, `CANCELLED`, `TIMED_OUT`, or `LOST`); canonical run result (`DELIVERED`, `NO_CHANGES`, `BLOCKED`, or `ESCALATED`); actual host adapter provenance; local-interaction and shared-transport privacy results; closed result; authenticated reviewer and review time; and bounded safe notes. Machine enrollment does not count toward exit until authenticated reviewer provenance is present.

Do not record fallback/substitution claims, commands, raw arguments, environment, credentials, paths, prompts, transcript, keystrokes, terminal content, source bodies, document bodies, or attachment handles.
