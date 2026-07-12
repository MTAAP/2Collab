# Foundation Local Evidence: foundation-9c8fc20edcec7ac7

- Schema version: 1
- Package status: PACKAGE_LOCAL_VERIFIED
- Foundation status: IN_PROGRESS_EXTERNAL
- Canonical exit criterion: NOT_MET
- Canonical exit criterion (verbatim): "Exit when both owners can start headless and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server backup and isolated restore drills pass; and one week of dogfood produces no need for direct database repair."
- Tested repository commit: `9c8fc20edcec7ac7b12950be5acf748d38889b4b`
- Dirty-tree state during final gate: `?? docs/evidence/foundation/live-evidence.json` (the initialized evidence artifact, not executable input)
- Build identifier: `foundation-9c8fc20edcec7ac7`
- Bun/platform/architecture: `1.3.10 / macOS / arm64`
- `bun.lock` SHA-256: `a04c32dac87ba8d31dd96dbcd7cc926d2af7e3cf6d7137872decfec18f2a383f`
- Tested-build artifact-manifest SHA-256: `6ea168823f5e1b6f5f6906b19e5953f7f9ebb463b41d67702ea32c5dd01d9ca6`
- Compiled `collab` SHA-256: `e2c4804406f6a58a1b127307eae1cf950e542df23a8355d246eb06bc7bd8b1a4`
- Server bundle SHA-256: `03b373701cc641681e1ad94d065ea74612097b008008bfce58aad1e951485b04`
- Tested image manifest: `dbad9f3258f45560a39559235fb9dfc9b985face0207b472820324dcf8e5913f`
- Safe audit/event/run identifiers: MISSING
- Human reviewer: UNREVIEWED

The tested-build artifact manifest was generated outside the source inventory. This later evidence document and its commit are not the tested executable build.
The build identifier, repository commit, and artifact-manifest digest above exactly match `live-evidence.json`. This historical record has no shared clean-build evidence envelope and therefore remains local, unreviewed proof only.

## Command record

| Command | Start UTC | End UTC | Duration ms | Exit | Result |
|---|---:|---:|---:|---:|---|
| `bun ci` | 2026-07-11T17:48:13.976Z | 2026-07-11T17:48:14.013Z | 37 | 0 | PASS |
| `bun run format:check` | 2026-07-11T17:48:14.197Z | 2026-07-11T17:48:14.475Z | 279 | 0 | PASS |
| `bun run lint` | 2026-07-11T17:48:14.659Z | 2026-07-11T17:48:14.863Z | 204 | 0 | PASS |
| `bun run typecheck` | 2026-07-11T17:48:15.045Z | 2026-07-11T17:48:15.817Z | 771 | 0 | PASS |
| `bun run test` | 2026-07-11T17:48:16.026Z | 2026-07-11T17:48:36.041Z | 20015 | 0 | PASS |
| `bun run build` | 2026-07-11T17:48:36.248Z | 2026-07-11T17:48:36.821Z | 573 | 0 | PASS |
| `bunx playwright install chromium` | 2026-07-11T17:48:37.012Z | 2026-07-11T17:48:37.410Z | 398 | 0 | PASS |
| `bun run test:e2e:run` | 2026-07-11T17:48:37.611Z | 2026-07-11T17:48:39.586Z | 1975 | 0 | PASS |
| `bun run audit:public` | 2026-07-11T17:48:39.779Z | 2026-07-11T17:48:39.974Z | 195 | 0 | PASS |
| `bash tests/scripts/compose-config-with-temporary-secrets.sh` | 2026-07-11T17:48:40.153Z | 2026-07-11T17:48:40.330Z | 176 | 0 | PASS |
| `docker compose config --quiet` | 2026-07-11T17:49:58.803Z | 2026-07-11T17:49:58.853Z | 50 | 1 | BLOCKED_ENV |
| `docker build --tag 2collab:verify .` | 2026-07-11T17:48:40.530Z | 2026-07-11T17:48:41.983Z | 1453 | 0 | PASS |
| compiled `collab --version` smoke | 2026-07-11T17:48:42.181Z | 2026-07-11T17:48:42.989Z | 808 | 0 | PASS |
| packaged server listener/health/shutdown smoke | 2026-07-11T17:49:43.677Z | 2026-07-11T17:49:43.803Z | 126 | 0 | PASS |
| hardened-image readiness smoke | 2026-07-11T17:49:44.055Z | 2026-07-11T17:49:44.659Z | 604 | 0 | PASS |
| authenticated backup create/verify drill | 2026-07-11T17:49:50.455Z | 2026-07-11T17:49:50.563Z | 108 | 0 | PASS |
| offline isolated restore drill | 2026-07-11T17:49:50.734Z | 2026-07-11T17:49:50.912Z | 178 | 0 | PASS |
| `bun run evidence:verify` | 2026-07-11T17:48:43.180Z | 2026-07-11T17:48:43.210Z | 30 | 0 | PASS |
| `bun run evidence:validate` | 2026-07-11T17:48:43.405Z | 2026-07-11T17:48:43.460Z | 56 | 0 | PASS |
| `bun run evidence:foundation-exit` | 2026-07-11T17:48:43.669Z | 2026-07-11T17:48:43.726Z | 56 | 2 | PASS (EXPECTED PENDING) |

`bun run test` passed 468 tests in 94 files. Browser execution passed 5 tests. The unconfigured Compose command is `BLOCKED_ENV` because its required deployment variables and secret-file paths were intentionally absent; the temporary-secret Compose fixture passed. The image readiness smoke used isolated test-only mounts and a host UID override required by Docker Desktop bind-mount ownership.

The source manifest and deterministic archive are regenerated and verified by the evidence commit after this record is written, avoiding a manifest self-reference while retaining this document in the normal source inventory.

## Requirement disposition

- `FND-001` through `FND-004`, `FND-006` through `FND-012`, and `FND-014` through `FND-018`: LOCAL_PROOF_COMPLETE, UNREVIEWED.
- `FND-005`: IN_PROGRESS_EXTERNAL; no authentic two-machine runtime/host/mode matrix rows exist.
- `FND-013`: IN_PROGRESS_EXTERNAL; local backup/restore proof passes, but no reviewed copied-backup isolated restore row exists.
- `FND-019`: IN_PROGRESS_EXTERNAL; zero reviewed dogfood days exist.

No requirement is marked `PASS`. No external or timed observation has been fabricated.
