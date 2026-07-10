# Contributing to 2Collab

2Collab welcomes focused contributions that make agent coordination safer, simpler, and more useful for solo developers and 1-3 person teams.

## Before changing code

1. Read [Decision Precedence](docs/DECISION-PRECEDENCE.md).
2. Find the governing requirement in the [Product Spec](docs/product/PRODUCT-SPEC.md).
3. Check the [acceptance matrix](docs/acceptance/ACCEPTANCE-MATRIX.md) and active phase plan.
4. Search open issues and accepted ADRs for the same decision.
5. Open a proposal before implementing a change that conflicts with a canonical decision.

Security vulnerabilities must follow the private process in [SECURITY.md](SECURITY.md), not a public issue or pull request.

## Development setup

Install Bun 1.3.10, then run:

```bash
bun ci
bun run dev
```

Docker is optional for application development but required to verify container changes.

## Test-first workflow

For executable behavior:

1. Add the smallest test that proves the missing behavior.
2. Run it and confirm it fails for the intended reason.
3. Implement the narrowest passing change.
4. Refactor without weakening the proof.
5. Run the relevant focused and full verification commands.

Documentation-only changes still require link, public-hygiene, and manifest verification.

## Code and dependency expectations

- Use the Bun-only scripts in `package.json`.
- Keep dependencies exact and justify additions in the pull request.
- Preserve the module boundaries in [System Architecture](docs/architecture/SYSTEM-ARCHITECTURE.md).
- Use UPPERCASE values for enum-like states.
- Never include credentials, private source content, absolute local paths, durable raw transcripts, or generated runtime state.
- Keep changes small enough that reviewers can verify the behavior and security impact.

## Verification

The ordinary source check is:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

For web, container, documentation, or release-surface changes, also run the corresponding commands:

```bash
bunx playwright install chromium
bun run test:e2e
bun run audit:public
bun run manifest:verify
docker compose config --quiet
docker build --tag 2collab:verify .
```

Include the exact commands and results in the pull request. If a check cannot run in the current environment, state the limitation and do not represent it as passing.

## Pull requests

- Keep one coherent outcome per pull request.
- Link the requirement, issue, or accepted decision being implemented.
- Explain product, security, schema, migration, and rollback impact when relevant.
- Update acceptance evidence and derived documentation with behavior changes.
- Do not rewrite the Product Spec through a lower-authority document.
- Do not publish releases or mutate external services as part of an ordinary contribution.

