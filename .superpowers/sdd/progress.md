# v1 implementation progress

Updated 2026-07-11. This is a progress index, not an acceptance result. The Product Spec, ADRs, and Acceptance Matrix retain decision precedence.

| Slice | Implementation state | Acceptance state |
|---|---|---|
| Foundation | Tasks 1-16 substantially implemented; acceptance machinery present | Local proof available; authentic two-owner/two-machine matrix, reviewed copied restore, and seven consecutive reviewed dogfood days remain external |
| GitHub coordination | Connector projections, guarded mutations, delivery paths, and parity surfaces implemented locally | Disposable provider journey remains external; provider resource/revision and audit records required |
| Outline collaboration | OAuth, attribution, read/write grants, conflicts, revocation, and collaboration paths implemented locally | Approved two-member provider journey remains external; provider and Collab IDs required |
| Bounded automation | Typed definitions, authoring, execution, joins, decisions, loops, gates, and local journeys implemented | Real-PR Claude/Codex canonical workflow remains external |

No requirement is promoted to live `PASS` by fixtures, React state, screenshots, historical command summaries, or a skipped/synthetic report. Live promotion requires the shared clean-build evidence envelope and the verbatim phase exit criterion.

The exact bare Compose configuration gate is self-contained. Runtime startup still requires operator-supplied session and secret-file material and fails closed without it.
