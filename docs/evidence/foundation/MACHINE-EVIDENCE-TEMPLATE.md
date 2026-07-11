# Machine Evidence Template

Create a strict JSON row accepted by `MachineEnrollmentSchema` or `MachineRunEvidenceSchema` in `scripts/evidence/foundation-contract.ts`.

Record only opaque IDs; frozen build and artifact IDs; runner epoch; policy, mapping, and profile revisions; safe profile fingerprint; runtime; host; mode; Web or CLI launch surface; UTC lifecycle times; separate attempt lifecycle and run result; actual host adapter provenance; local-interaction and shared-transport privacy results; closed result; authenticated reviewer and review time; and bounded safe notes.

Do not record fallback/substitution claims, commands, raw arguments, environment, credentials, paths, prompts, transcript, keystrokes, terminal content, source bodies, document bodies, or attachment handles.
