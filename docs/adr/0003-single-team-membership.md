# ADR 0003: Single-Team Membership

**Status:** ACCEPTED  
**Canonical references:** [Single-Team Deployment V1](../product/PRODUCT-SPEC.md#single-team-deployment-v1), [Team Roles V1](../product/PRODUCT-SPEC.md#team-roles-v1)

## Context

The target user is a trusted one-to-three-person development team. Multi-tenant administration would obscure the core workflow.

## Decision

Each deployment contains exactly one team. A member is either in the team or not. Roles are `OWNER` and `MEMBER`, multiple owners are allowed, and the last owner cannot be removed or demoted. Project access is team-wide.

## Consequences

There are no project roles, tenant selectors, billing tiers, organization hierarchies, or enterprise policy consoles in v1.
