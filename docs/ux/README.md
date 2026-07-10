# UX Foundation

> **Authority level:** Derived guidance; does not add or amend product behavior.  
> **Canonical source:** [Product Spec](../product/PRODUCT-SPEC.md). If this document conflicts with the Product Spec, the Product Spec wins.

The 14 approved mockups establish the web application's information hierarchy. They are a visual foundation, not pixel-perfect production assets and not an alternate state model.

## Screen Map

| Mockup | Purpose | Canonical Product Spec areas |
|---|---|---|
| [00 Product map](mockups/00-product-map.png) | Whole-product navigation and surface map | [Mental Model](../product/PRODUCT-SPEC.md#mental-model), [Core Components](../product/PRODUCT-SPEC.md#core-components) |
| [01 Command center](mockups/01-command-center.png) | Shared operational projection of records and runs | [Command Center Dashboard V1](../product/PRODUCT-SPEC.md#command-center-dashboard-v1) |
| [02 Personal inbox](mockups/02-personal-inbox.png) | Deduplicated personal attention stream | [Notification Inbox V1](../product/PRODUCT-SPEC.md#notification-inbox-v1) |
| [03 GitHub work hub](mockups/03-github-work-hub.png) | Issue, PR, Milestone, and Project projections | [GitHub Issues V1 Role](../product/PRODUCT-SPEC.md#github-issues-v1-role), [GitHub Projects V1](../product/PRODUCT-SPEC.md#github-projects-v1) |
| [04 GitHub issue detail](mockups/04-github-issue-detail.png) | Native source state plus coordination and delegation | [Assignment and Delegation V1](../product/PRODUCT-SPEC.md#assignment-and-delegation-v1) |
| [05 Outline knowledge](mockups/05-outline-knowledge-workspace.png) | Federated read, human editing, grants, and conflicts | [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role) |
| [06 New run composer](mockups/06-new-run-composer.png) | Source-agnostic run and workflow launch | [New Run Composer V1](../product/PRODUCT-SPEC.md#new-run-composer-v1) |
| [07 Live agent run](mockups/07-live-agent-run.png) | Run, attempt, checkpoint, evidence, and recovery | [Agent Run Lifecycle V1](../product/PRODUCT-SPEC.md#agent-run-lifecycle-v1), [Execution Attempt Lifecycle V1](../product/PRODUCT-SPEC.md#execution-attempt-lifecycle-v1) |
| [08 Workflow library](mockups/08-workflow-library.png) | Team templates and personal bindings | [Team Workflow Templates and Personal Workflow Presets V1](../product/PRODUCT-SPEC.md#team-workflow-templates-and-personal-workflow-presets-v1) |
| [09 Workflow studio](mockups/09-workflow-studio-hybrid.png) | Typed React Flow authoring and validation | [Visual Workflow Authoring V1](../product/PRODUCT-SPEC.md#visual-workflow-authoring-v1) |
| [10 Runner fleet](mockups/10-runner-fleet.png) | Runner ownership, exposure, compatibility, and activity | [Execution Authority and Runner Exposure V1](../product/PRODUCT-SPEC.md#execution-authority-and-runner-exposure-v1) |
| [11 Integrations](mockups/11-integrations.png) | GitHub App and split Outline identities | [Connector Authority and Revocation V1](../product/PRODUCT-SPEC.md#connector-authority-and-revocation-v1) |
| [12 Team and auth](mockups/12-team-auth-settings.png) | Passkeys, invitations, owners, recovery, offboarding | [Authentication Architecture V1](../product/PRODUCT-SPEC.md#authentication-architecture-v1), [Member Offboarding and Authority Revocation V1](../product/PRODUCT-SPEC.md#member-offboarding-and-authority-revocation-v1) |
| [13 First-run setup](mockups/13-first-run-setup.png) | Single-team bootstrap and connector choice | [Canonical Installation V1](../product/PRODUCT-SPEC.md#canonical-installation-v1) |

## Component Vocabulary

Use source-owned shadcn/ui components. Compose Command Center and source views from Sidebar, Breadcrumb, Tabs, Card, Table, Badge, Avatar, Dropdown Menu, Sheet, Dialog, Alert, Empty, Skeleton, Separator, and accessible form primitives. Use React Flow only for canvas interaction; serialize the typed Workflow Definition independently from canvas layout.

Use semantic tokens such as `bg-background`, `text-muted-foreground`, and component variants. Layout classes may position components but must not override component colors or typography. Use `gap-*`, visible focus indicators, real headings and landmarks, labeled icon-only controls, and status text that does not depend on color.

## Responsive and Accessibility Contract

- The smallest supported authoring viewport is 1024 CSS pixels; narrower workflow views become inspect-only with an explicit explanation.
- Operational and source surfaces remain usable at 390 CSS pixels without horizontal page overflow.
- Sidebars collapse to a Sheet on narrow screens; primary actions remain keyboard reachable.
- Dialogs and Sheets have accessible titles. Tables expose headers. Dynamic run updates use restrained live regions.
- Motion communicates state changes only and respects `prefers-reduced-motion`.
- Attempts, runs, source state, and workflow state retain distinct labels. Never collapse `WAITING`, `LOST`, `FAILED`, and `BLOCKED` into a generic error badge.
