# ADR 0004: Federated Sources and Universal Coordination Records

**Status:** ACCEPTED  
**Canonical references:** [Federated Source Model](../product/PRODUCT-SPEC.md#federated-source-model), [Universal Coordination Record V1](../product/PRODUCT-SPEC.md#universal-coordination-record-v1)

## Context

GitHub and Outline must remain authoritative while source-free runs still need a shared identity and history.

## Decision

2Collab stores coordination, lifecycle, provenance, revisions, and bounded projections. It retrieves source bodies on demand and does not create a competing task or document database. Every Agent Run belongs to one Coordination Record; source references may be attached later without changing run identity.

## Consequences

Connectors must expose freshness and provenance. Inbox and boards are projections, not writable task-state systems.
