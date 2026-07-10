# Decision Precedence

This document defines authority between repository artifacts. It does not amend the [Product Spec](product/PRODUCT-SPEC.md).

1. The Product Spec defines product scope, semantics, lifecycles, permissions, and non-goals.
2. A later accepted ADR may amend one named Product Spec decision only when it explicitly identifies the superseded section and the replacement decision. The seed ADRs do not amend the Product Spec.
3. The Acceptance Matrix defines observable proof but cannot add product behavior.
4. Architecture, security, domain, and UX documents explain canonical requirements without widening them.
5. Implementation plans sequence delivery and may not override any source above them.
6. Mockups define intended visual state and information hierarchy. If their copy or semantics conflict with the Product Spec, the Product Spec wins and the mockup must be corrected.
7. Executable code proves what exists today; it does not silently redefine the contract. A discovered contradiction requires an explicit spec or ADR decision before behavior changes.

Conversation history, issue comments, generated summaries, and agent assumptions are not hidden specification sources.
