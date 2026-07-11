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

## Current implementation and acceptance state

The checked-in executable now contains substantial implementations for all four delivery slices: Foundation, GitHub coordination, Outline collaboration, and bounded automation. The implementation includes durable server modules, shared ExecutionAuthority consumption, local runner/runtime adapters, connector projections and guarded mutations, typed executable workflows, CLI/MCP/HTTP surfaces, and browser journeys.

Implementation coverage is not acceptance. The Foundation two-machine/seven-day observation and the approved provider-backed GitHub, Outline, and real-pull-request automation journeys remain external obligations. Consult `docs/evidence/`; local fixtures, UI state, and historical command summaries cannot be recorded as live `PASS`.

New evidence must use the shared clean-build envelope, name the exact repository revision and artifact/lock/manifest digests, include non-synthetic test-report provenance with zero skips, identify reviewers, and retain the canonical phase exit criterion verbatim.

## Required Verification

```bash
bun ci
bun run verify
docker compose config --quiet
```

The Docker build and live container health check are also required before a release or deployment change is considered complete.
