# ADR 0007: Workflow Semantics Separate from Canvas Layout

**Status:** ACCEPTED  
**Canonical references:** [Visual Workflow Authoring V1](../product/PRODUCT-SPEC.md#visual-workflow-authoring-v1), [Automated Run Workflows V1](../product/PRODUCT-SPEC.md#automated-run-workflows-v1)

## Context

React Flow is useful for authoring but its node and edge representation is not a durable execution contract.

## Decision

A versioned, validated Workflow Definition owns typed steps, transitions, joins, bounds, and terminal results. Canvas Layout separately owns positions, viewport, and presentation metadata. The execution engine consumes only the Workflow Definition.

## Consequences

Layout changes do not change workflow semantics. Runtime/model/runner choices remain personal bindings, and invalid graphs never reach execution.
