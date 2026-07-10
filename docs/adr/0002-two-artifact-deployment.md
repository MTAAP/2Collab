# ADR 0002: Two-Artifact Deployment

**Status:** ACCEPTED  
**Canonical references:** [Deployment Model](../product/PRODUCT-SPEC.md#deployment-model), [Packaging V1](../product/PRODUCT-SPEC.md#packaging-v1)

## Context

Shared coordination and trusted local execution require different trust and deployment locations without requiring a service fleet.

## Decision

The repository produces `collab-server` and the host-specific local `collab` executable. The supported deployment is one server container with a persistent volume plus one local installation on each runner machine.

## Consequences

The browser build is served by `collab-server`, not deployed separately. Host-specific CLI binaries are release artifacts and never enter the portable source archive.
