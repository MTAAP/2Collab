# ADR 0005: Trusted-Runner Execution Authority

**Status:** ACCEPTED  
**Canonical references:** [Execution Authority and Runner Exposure V1](../product/PRODUCT-SPEC.md#execution-authority-and-runner-exposure-v1), [Offline Safety Boundary](../product/PRODUCT-SPEC.md#offline-safety-boundary)

## Context

Claude, Codex, Orca, and custom commands run on trusted developer machines. Coordination controls must be strong without claiming nonexistent filesystem isolation.

## Decision

The server authorizes exact attempts and sensitive operations through single-use permits, fenced Authority Sessions, revision-bound approvals, and mutation leases. Trusted Native and Orca hosts normally provide `ADVISORY` repository assurance. `ENFORCED` is reserved for an adapter that can technically prevent prohibited operations.

## Consequences

Runner ownership, team exposure, interaction mode, and execution host are independent. Revocation removes authority immediately, but the system never falsely claims an unreachable local process was physically stopped.
