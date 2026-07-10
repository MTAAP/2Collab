# Start Here

This is the maintainer and implementation-agent entry point for 2Collab.

## Reading Order

1. [Decision Precedence](DECISION-PRECEDENCE.md) defines which artifact wins when two sources appear to disagree.
2. [Product Spec](product/PRODUCT-SPEC.md) is the canonical product contract.
3. [System Architecture](architecture/SYSTEM-ARCHITECTURE.md), [Domain Model](architecture/DOMAIN-MODEL.md), [Execution Authority](architecture/EXECUTION-AUTHORITY.md), and [Security Model](security/SECURITY-MODEL.md) translate the contract into implementation boundaries.
4. [UX Foundation](ux/README.md) maps the approved screens to product semantics and shadcn/ui vocabulary.
5. [Acceptance Matrix](acceptance/ACCEPTANCE-MATRIX.md) identifies the observable proof for each v1 requirement.
6. [Master Implementation Plan](plans/00-MASTER-IMPLEMENTATION-PLAN.md) and its four phase plans define delivery order.
7. [Implementation Handoff](../agent_docs/IMPLEMENT.md) is the standalone execution brief for a fresh agent.

## Repository Baseline

The checked-in executable is intentionally small. It proves the Bun/Hono server, React/Vite/shadcn web shell, local CLI, tests, container, and public-repository controls. It does not contain fake authentication, fake connectors, an in-memory product database, demo runs, or placeholder workflow behavior.

Start product work with Phase 1 and a failing test. Do not infer product behavior from the scaffold page.

## Required Verification

```bash
bun ci
bun run verify
docker compose config --quiet
```

The Docker build and live container health check are also required before a release or deployment change is considered complete.
