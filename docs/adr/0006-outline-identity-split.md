# ADR 0006: Split Outline Identities

**Status:** ACCEPTED  
**Canonical references:** [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role), [Connector Authority and Revocation V1](../product/PRODUCT-SPEC.md#connector-authority-and-revocation-v1)

## Context

Human collaboration needs native member attribution, while unattended agent writes need a stable, auditable identity.

## Decision

Direct human Outline edits use each member's delegated OAuth identity. Agent-authored edits use one team bot identity plus exact run, attempt, grant, and revision provenance in 2Collab.

## Consequences

Bot access does not impersonate members. Member OAuth, bot authority, Context Read Scopes, and Document Write Grants are revocable independently.
