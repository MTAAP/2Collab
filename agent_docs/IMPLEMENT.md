# Implement 2Collab V1

You are implementing the public `MTAAP/2Collab` repository from its reviewed, settled specification package.

## Authority and Reading Order

Read these files before changing product code:

1. `docs/DECISION-PRECEDENCE.md`
2. `docs/product/PRODUCT-SPEC.md`
3. `docs/architecture/SYSTEM-ARCHITECTURE.md`
4. `docs/architecture/DOMAIN-MODEL.md`
5. `docs/architecture/EXECUTION-AUTHORITY.md`
6. `docs/security/SECURITY-MODEL.md`
7. `docs/acceptance/ACCEPTANCE-MATRIX.md`
8. `docs/plans/00-MASTER-IMPLEMENTATION-PLAN.md`
9. The one phase plan you are executing

The Product Spec and accepted ADRs are settled. Verify repository freshness, referenced paths, current dependency APIs, and contradictions with live code. If that verification succeeds, do not re-litigate product direction. If it reveals a real contradiction, stop and report the exact evidence before changing semantics.

## Mission

Implement one phase at a time in this order:

1. `docs/plans/01-FOUNDATION.md`
2. `docs/plans/02-GITHUB-COORDINATION.md`
3. `docs/plans/03-OUTLINE-COLLABORATION.md`
4. `docs/plans/04-BOUNDED-AUTOMATION.md`

Do not begin a later phase until the preceding phase's entry dependencies, acceptance identifiers, security drills, and exit gate are green. Keep the two-artifact, single-package architecture intact.

## Execution Rules

- Start each behavior with a failing test and observe the expected failure before implementation.
- Implement the smallest behavior that satisfies the named acceptance identifier, then refactor under green tests.
- Keep policy and SQLite transaction details inside deep domain modules. Add adapters only for true external or remote-owned seams defined by the architecture.
- Use UPPERCASE string values for all product states and discriminants named in the Product Spec.
- Treat GitHub and Outline as authoritative sources. Never invent a competing lifecycle or persist source bodies for convenience.
- Treat trusted Native and Orca execution as `ADVISORY` unless a technical adapter actually enforces the restriction.
- Never park an agent process while waiting for a human decision. Persist the decision point, exit the attempt, and authorize a fresh attempt when work continues.
- Preserve exact-revision approvals, single-use permits, fenced sessions, absolute deadlines, immutable attempt budgets, and explicit revocation behavior.
- Keep React Flow canvas layout separate from the typed Workflow Definition.
- Use Context7 and official primary documentation before writing against version-sensitive external APIs.
- Do not add another package manager, workspace graph, database, runtime language, deployable service, plugin marketplace, or fake product implementation.

## Required Proof

For every task, report:

- Acceptance identifiers addressed.
- The failing test and why it failed before implementation.
- Exact files changed.
- Focused verification output.
- Full `bun run verify` output at a phase checkpoint.
- Security/failure drills required by the phase plan.
- Any environment limitation separated from code defects.

Before declaring a phase complete, run the phase gate plus:

```bash
bun ci
bun run verify
docker compose config --quiet
docker build -t 2collab:verify .
```

Boot the container with a strong ephemeral `SESSION_SECRET`, poll `/healthz`, verify its JSON contract, and remove it.

## External-Change Boundary

You may edit and verify the local repository. Do not push, merge, create or modify public issues, post comments, configure GitHub Apps or Outline OAuth, publish images or releases, rotate real credentials, or deploy without explicit human authority for that exact action.

When an acceptance test needs a real external integration, prepare the local implementation and test harness first, then request only the minimum explicit authority or credential setup required for the live drill.
