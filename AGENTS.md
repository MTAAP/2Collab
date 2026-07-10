# Agent Guidelines

These instructions apply to every automated or human-assisted change in this repository.

## Decision precedence

Use the following order when sources disagree:

1. `docs/product/PRODUCT-SPEC.md`
2. Accepted ADRs in `docs/adr/`
3. Derived architecture and security guidance
4. Acceptance matrix and phase plans
5. UX mockups
6. Existing code

Do not silently reinterpret a settled product decision through code. Surface the conflict and update the canonical decision explicitly before implementation.

## Toolchain

- Use Bun 1.3.10 for installs, scripts, tests, builds, and local tooling.
- Keep one root `package.json` and one `bun.lock`.
- Pin every dependency to one exact version.
- Do not add npm, pnpm, Yarn, workspaces, Turborepo, or another application build graph.
- Verify external library APIs against current primary documentation before using them.

## Architecture boundaries

- The shared server owns coordination state, authority decisions, external connector credentials, and projections.
- The local runner owns worktrees, processes, terminals, local commands, and developer credentials.
- Web, CLI, MCP, workflows, and runner transport must consume the same `ExecutionAuthority` decisions rather than duplicating policy.
- Runtime adapters prepare invocations and normalize output. They do not own runner security, worktree selection, or Agent Run success.
- React Flow objects are presentation state. The typed Workflow Definition is executable truth.
- GitHub and Outline remain authoritative for their native source content and state.

## Implementation rules

- Write the failing test before executable behavior, then make the smallest implementation pass.
- Keep Hono app construction import-safe and inject external state into testable functions.
- Use UPPERCASE string values for enum-like states.
- Keep user-facing errors stable and bounded. Never echo secrets or raw environment values.
- Keep browser terminal input and interactive transcripts local.
- Do not add emoji to repository files.
- Do not commit generated build output, local databases, credentials, transcripts, test reports, or host-native CLI binaries.
- Preserve repository-relative paths and LF line endings.

## Verification

Run the checks relevant to the change, and run the full sequence before declaring a package-ready result:

```bash
bun ci
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e:run
bun run audit:public
bun run manifest:verify
docker compose config --quiet
docker build --tag 2collab:verify .
```

Report environment failures separately from code defects. Do not claim an unrun check passed.

## External effects

Do not push, merge, publish packages or releases, create repositories, mutate external integrations, or post public comments without explicit authority.

