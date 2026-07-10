# ADR 0001: Bun Single-Package Architecture

**Status:** ACCEPTED  
**Canonical references:** [One Language, One Repo, One Build System](../product/PRODUCT-SPEC.md#9-one-language-one-repo-one-build-system), [Packaging V1](../product/PRODUCT-SPEC.md#packaging-v1)

## Context

The first iteration accumulated multiple application stacks and deployment paths before validating the coordination workflow.

## Decision

2Collab uses Bun and TypeScript with one root `package.json`, one lockfile, one test graph, and no workspace orchestrator. Hono, React/Vite, the CLI, protocol types, migrations, and tests live in this package.

## Consequences

Cross-module changes share one verification bar and dependency graph. A second language, package manager, or workspace boundary requires an ADR that explicitly amends the canonical decision.
