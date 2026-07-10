---
title: MTAAP Core Knowledge — From SaaS Webapp to Federated Agent Coordination
date: 2026-07-09
tags:
  - knowledge
  - architecture
  - rebirth
  - cli
  - mcp
aliases:
  - Core Idea
  - New Iteration Brief
status: accepted
---

# 2Collab Product Specification

## Executive Summary

MTAAP began as a **multi-tenant SaaS webapp** for coordinating AI-assisted software development across teams. The central idea was strong: an **MCP-first, agent-agnostic coordination layer** that lets any AI agent claim tasks, report progress, and drive a git/PR lifecycle. The execution became heavy and unfocused: a full SaaS platform (billing, multi-tenancy, org management, admin dashboards, LDAP, OAuth, audit logs) was built before the core agent workflow was proven, and an RFC-001 plugin/integration system introduced a 6-phase architectural pivot that would have dwarfed the original product.

This document extracts the reusable knowledge. The intended next iteration is a **lightweight, self-hostable, always-on coordination system** for a solo developer or 1–3-person team. Its shared server is authoritative for MTAAP coordination state; the CLI, web interface, and MCP server use that same state, while agent execution, worktrees, terminals, and git credentials remain on developers' machines. The MCP-first design remains a core insight, but the new iteration should strip away billing, enterprise multi-tenancy, and admin-platform breadth while prioritizing **adaptability, observability, and minimal operational overhead**.

## The Original Core Idea

The core idea was described as "OpenSpec on steroids" in the original scope document: a central hub + MCP server combination where teams define epics and stories, and agents claim tasks through a protocol. The key claim was that MCP-first architecture makes the workflow portable and tool-agnostic.

The intended workflow was:

1. Team defines epics and user stories in the hub.
2. Developers or agents claim tasks via MCP.
3. Agents fetch full task context (description, acceptance criteria, project conventions, recent completed work) via MCP.
4. Progress reports back to the hub in real time.
5. Task completion triggers branch creation, PR creation, and Kanban state transitions.
6. Other team members see updates instantly.

The insight was not just a Kanban board or a git helper. It was the **protocol boundary** between human task definition and agent execution: a stable, semantic contract that any agent can implement.

## What Made the Original Project Great

### 1. MCP-First, Agent-Agnostic Coordination

The strongest insight was the decision to expose coordination through a Model Context Protocol server rather than building IDE plugins or agent-specific integrations. This meant the same `list_projects`, `get_task`, `assign_task`, `update_progress`, `complete_task` flow could in principle work with Claude Code, OpenCode, Cursor, GitHub Copilot, or any future agent that speaks MCP.

The MCP server was published to npm as `@mtaap/mcp` and designed to run with only two environment variables: `COLLAB_API_KEY` and `COLLAB_BASE_URL`. This was the right direction for portability.

### 2. The Task State Machine as a Semantic Contract

The fixed lifecycle `DRAFT -> TODO -> IN_PROGRESS -> REVIEW -> DONE` gave agents a simple, unambiguous vocabulary. The state machine made it clear what each party owed:

- `TODO` means ready to be picked up.
- `IN_PROGRESS` means someone is working on it.
- `REVIEW` means work is complete and a PR exists.
- `DONE` means the PR was merged.

This is a clear coordination primitive. The state machine was not arbitrary project management; it encoded the handoff between human and agent.

### 3. Branch-and-PR as an Agent Action

The original design tied task lifecycle to git workflow: `assign_task` suggested a branch name, `complete_task` suggested PR title and body, and GitHub webhooks moved the task to `DONE` when a PR merged. This made the abstract task state concrete in the repository. It gave the agent a clear, inspectable artifact for each task.

### 4. Team Observability

The Kanban board, real-time WebSocket events, and agent session tracking were meant to give teams visibility into what agents were doing. For a team of humans using AI agents, this is a real need: without a shared view, multiple agents can duplicate work or leave tasks in limbo.

### 5. The Desktop Companion Concept

The `collab-agent` Tauri app was a response to a real constraint: a browser cannot spawn a local terminal. The idea of a lightweight local bridge that spawns Claude Code or OpenCode with a task context was correct, even if the Tauri/Rust implementation was heavier than necessary.

### 6. Shared Agent Launch and Observability

The original project had the right intuition that teams should be able to launch and observe agents from a shared surface, not only from the local terminal. The "Spawn Agent" button in the web UI and the `collab-agent` Tauri app were attempts to let any team member trigger an agent run from a visible task. The collaborative trigger is a real need; the implementation was too heavy. In the new iteration, the same Agent Run should be triggerable from the CLI, from the focused web interface, or from another agent via MCP, all backed by the same shared coordination server whether or not an external work item exists.

## What Did Not Work

### 1. SaaS and Multi-Tenancy Before Product-Market Fit

The codebase built a full SaaS platform before the core agent coordination was proven. The monorepo contains:

- Multi-tenant organization and user management.
- Seat-based billing with RevenueCat and Stripe.
- Pricing tiers (`FREE`, `PRO`, `ENTERPRISE`) with project and seat limits.
- LDAP/SSO authentication, OAuth 2.1 dynamic client registration, and audit logging.
- Admin dashboards for billing, tags, users, and settings.
- On-prem vs SaaS deployment modes.

These are enterprise concerns. They consumed development time and made the codebase harder to evolve before the core workflow was validated. The deployment blockers analysis estimated the platform was only 60% ready for SaaS launch, with 83% of API routes untested and a long list of security and infrastructure gaps still open.

### 2. Scope Creep in RFC-001

RFC-001, "Integration Plugin System & Customizable Phases," proposed a 6-phase, multi-month architectural pivot: a three-layer state model (Work Phases → Board Stages → External Mappings), a plugin runtime with sandboxed execution, a sync engine for Jira/Linear/GitHub Projects, custom MCP tools, an automation engine, and a plugin marketplace. This was not an incremental enhancement. It was a different, much larger product.

The RFC recognized the right problem (teams cannot abandon their existing tools), but its proposed solution was disproportionate and would have introduced a platform-within-a-platform. This is the clearest example of scope creep.

### 3. Web-First Instead of CLI-First

The project was built around a Next.js webapp as the central hub. The Kanban board, epic/story editor, admin settings, and real-time dashboard were the primary surfaces. The CLI/MCP experience was a consumer of the webapp's REST API.

This inverted the value proposition because the admin-heavy webapp defined the product while the agent workflow remained secondary. The problem was not the existence of a web interface; the new version needs a focused shared team surface alongside an excellent CLI, without rebuilding billing, enterprise administration, or general-purpose project management.

### 4. Heavy Technology Stack

The stack accumulated operational and cognitive overhead:

- Next.js 15, React 19, Supabase, PostgreSQL, Drizzle ORM.
- Tauri + Rust for the desktop companion.
- RevenueCat, Stripe, Sentry, Docker, GitHub Actions, Turborepo.

This is a large surface area for an unproven workflow. It made local setup, testing, and iteration slow. The `pnpm build` and deployment pipeline were necessary before any single change could be verified.

### 5. Missing or Incomplete Core Pieces

Despite the breadth, several core pieces were incomplete or missing:

- The `packages/git` package referenced in docs did not exist. GitHub URL parsing existed, but GitLab and Bitbucket were stubbed.
- Repository access verification was removed server-side; users were told to verify access themselves.
- The branch cleanup setting in the database was never checked in the webhook.
- The `collab-agent` integration with the webapp's session tracking was incomplete.
- Several web-socket event broadcasts were implemented in web API routes, not in the MCP server, leading to split responsibilities.

This suggests the team was spread too thin across breadth rather than depth.

### 6. The "MCP Apps" Confusion

The MCP server grew React UI components in `apps/mcp/ui/` and `apps/mcp/src/apps/`, including kanban, activity, agent-sessions, and task-details views. This blurred the boundary between the MCP server (a protocol endpoint) and the webapp (a user interface). It added build complexity without a clear user need.

### 7. Agent Spawning Was Too Heavy

The desktop companion was a Tauri/Rust application with a local HTTP server, terminal backend abstraction, and command whitelist. It solved a real problem, but the implementation was heavier than the context required. In the new model, agent spawning can be simpler: a `collab` local runner invokes the user's preferred agent with the right prompt and context.

## Technical Archaeology

### What Was Built

A significant amount of code was written:

- `apps/web`: Next.js 15 app with 50+ API routes, Kanban board, Supabase auth, real-time WebSocket, admin dashboards, and task management.
- `apps/mcp`: A publishable MCP server with ~20 tools, an API client, and a CLI entry point.
- `apps/collab-agent`: A Tauri desktop companion with a local HTTP server, terminal spawning, and CLI templates.
- `packages/core`: Shared types, enums, validation, prompts, and configuration.
- `packages/db`: Drizzle schema with 25+ tables, 7 migrations, and multi-tenant data models.
- `packages/auth`: Supabase auth, API key auth, LDAP, OAuth 2.1 token management, and audit logging.
- `packages/email`: SMTP templates and transport.

### What Was Planned but Not Built

- `packages/git`: A git provider abstraction for GitHub, GitLab, and Bitbucket.
- The plugin/runtime/Sync engine from RFC-001.
- Server-side agent orchestration and GitHub Actions automation.
- Many P1/P2 features: audit logs, custom workflows, mobile Kanban optimization, API versioning.

### The Deployment Reality

The `docs/SAAS-DEPLOYMENT-BLOCKERS.md` analysis showed the platform was ~60% ready for SaaS. The MCP server itself was rated 100% complete, while authentication, security, API, and frontend readiness ranged from 65% to 85%. This confirms where the effort was and was not: the MCP/agent surface was the most complete part, and the surrounding SaaS platform was the drag.

## Lessons for a Modern Shared Iteration

### 1. Start with the Coordination Workflow, Not the Admin Platform

The developer-facing CLI and the shared web surface are complementary primary interfaces. The CLI owns local execution ergonomics; the web interface owns team-visible creation, delegation, approvals, documents, and run observability. Both operate on the same coordination records:

- `collab list` shows tasks.
- `collab start <task>` spawns the agent with the right context.
- `collab status` reports progress.
- `collab complete` submits completion evidence and the PR reference.

The web interface is not an enterprise admin suite or a read-only afterthought. It is the always-on shared home where a small team sees work sources, context sources, active runs, pending decisions, and provenance.

### 2. Shared Coordination, Local Execution

The shared server owns leases, Workflow Executions, Agent Runs, grants, proposals, integration references, and verification evidence. A local runner owns worktrees, terminals, processes, and developer credentials. It may keep a bounded cache and durable outbox for short network interruptions, but it is never a competing source of truth for coordination state.

### 3. MCP Is the Right Boundary, but Keep It Thin

The MCP server should be a thin protocol adapter. It should not contain UI, billing, connector implementations, or admin logic. It translates semantic agent tool calls into authenticated operations on the shared coordination server. The `@mtaap/mcp` pattern of a separately usable protocol surface was correct; its responsibilities should be even narrower.

### 4. Separate Source State, Run Lifecycle, and PR State

The original `DRAFT → TODO → IN_PROGRESS → REVIEW → DONE` flow was valuable because it made handoffs explicit, but it collapsed several different authorities into one synthetic task state. The new iteration keeps them separate: GitHub owns issue, pull-request, Milestone, and Project field state; MTAAP owns Workflow Execution and Agent Run lifecycles. The web interface may derive a convenient phase such as "active run" or "awaiting review," but derived phases are explanations, not writable sources of truth. Custom task state machines are deferred until real use proves they are needed.

### 5. Git Operations Stay Local; GitHub Coordination Is Server-Side

The shared server uses a GitHub App to ingest issues, pull requests, milestones, selected GitHub Projects, and webhooks with explicitly granted repository and organization-project access. Branch creation, commits, pushes, and PR creation remain local agent operations using the developer's existing `git` and `gh` credentials. MTAAP records the resulting branch and PR references but never receives those personal git credentials.

### 6. Adaptability Over Feature Count

The new iteration should be designed to be pluggable along four axes:

- **Work-source adapters**: GitHub Issues and pull requests first, with GitHub Milestones and selected Projects as planning projections and Linear or other trackers possible later.
- **Context-source adapters**: Outline first, with Obsidian requiring a later local connector.
- **Execution hosts**: Orca and a native local host first, with agent runtimes handled separately by Execution Adapters.
- **Custom workflows**: portable, versioned Team Workflow Templates with typed transitions and hard bounds, without custom task-state machines.
- **Pluggable agent integrations**: Claude Code and Codex CLI first, with the same adapter contract validated against Pi and OpenCode and no arbitrary executable escape hatch in v1.
- **Project conventions**: per-project base branch, commit style, test command, and agent instructions.

The goal is a small, solid core that can be extended, not a platform that tries to cover every workflow out of the box.

### 7. No Billing, Enterprise Tenancy, or Admin Suite

For the new iteration, billing, cross-customer SaaS tenancy, enterprise directory integration, and broad administration are anti-features. A small team should be able to self-host one service, connect its tools, install the local runner, and begin coordinating work. The focused web interface and minimal project-member management are product requirements, not an invitation to rebuild the old SaaS platform.

### 8. Agent Launch Should Be Surface-Independent

The original project had the right intuition: a team member should be able to launch an agent from a shared view, not only from the terminal. The new iteration should define the Agent Run as a first-class durable concept that can be triggered from the CLI, from the focused web interface, or from another agent via MCP. The heavy Tauri desktop app should be replaced by a simpler local runner or by spawning the user's existing terminal/CLI directly.

### 9. One Language, One Repo, One Build System

The original stack was fragmented across Next.js, React, Supabase, PostgreSQL, Drizzle, Tauri, Rust, and Turborepo. This made local development, testing, and deployment slow. The new iteration should be standardized and lean:

- **One language for the whole system**. Prefer a language that can produce a self-contained local runner and a compact self-hosted server without duplicating domain logic.
- **One authoritative state store**, owned by the shared server. SQLite on a persistent volume is the obvious v1 choice for a 1–3-person team; the local runner uses only a cache and outbox.
- **One build system**. No monorepo tooling. No pnpm workspaces. No Turborepo. One `Cargo.toml`, one `go.mod`, or one `package.json`.
- **Minimal dependencies**. Prefer the standard library and well-maintained single-purpose crates/packages. Avoid frameworks that pull in a large dependency tree.
- **Two deployment artifacts at most**: a self-hosted service containing the web/API/MCP surfaces, and a local `collab` runner/CLI. Both come from the same codebase and build.

A concrete recommended starting point:

- **Bun + TypeScript** (selected for the new iteration). The same codebase can produce the local `collab` runner and the self-hosted service, including the web/API/MCP surfaces. SQLite is available via `bun:sqlite`, and `package.json` remains the only build file. This removes the Node/pnpm/Turborepo fragmentation while keeping fast iteration and the strongest MCP ecosystem fit.

Alternatives if Bun proves unstable:

- **Go** with `cobra` (CLI), `chi` (server), `mattn/go-sqlite3` (state), and `mcp-go`. Produces compact native artifacts but gives up TypeScript ecosystem leverage.
- **Rust** with `clap` (CLI), `tokio` + `axum` (server), `rusqlite` (state), and `serde`. Produces compact native artifacts, but the MCP and web iteration path is less mature.

The key is not the exact language, but the constraint: **one repo, one build system, at most two deployable artifacts, and minimal moving parts**. Bun is the best fit for iterating quickly while the design is still being validated.

## Proposed Direction for the New Iteration

### Mental Model

The new iteration is a **coordination bridge between work sources and personal agent execution environments**. A work source such as GitHub Issues defines what should be done. An execution environment such as Orca runs the developer's chosen agent. MTAAP connects them through a portable work lifecycle with ownership, progress, verification evidence, and provenance.

MTAAP is not a project management tool, agent runtime, terminal manager, or IDE. It does not replace GitHub Issues, Linear, Beads, Orca, or individual agent CLIs.

### Primary User and Adoption Model

The first target user is a **solo developer or a 1–3-person development team** in which each developer may run multiple AI coding agents. The product should optimize for daily local use, low setup cost, and coordination that remains understandable without a dedicated platform administrator.

The new iteration is intended to be developed as open source and dogfooded on its own development from the first usable release. Larger teams, enterprise governance, and general-purpose project management are not initial targets.

### System Role and Authority

Each participating system remains authoritative for a distinct kind of state:

- The **work source** owns the work item's intent, description, and native lifecycle.
- **MTAAP** owns the coordination record: the active lease, durable run identity, portable run lifecycle, verification evidence, and provenance.
- The **execution environment** owns live execution state such as worktrees, terminals, processes, and runtime-specific orchestration.

Adapters may project status and identifiers between systems, but a projection never becomes a second authoritative copy. For example, an Orca terminal exiting is execution evidence; it does not by itself complete the MTAAP run or close the GitHub issue.

### Deployment Model

The always-on shared team surface is part of the core product, not an optional future dashboard. It should be self-hostable and provide the authoritative MTAAP coordination state for a solo developer or 1–3-person team. The CLI, web interface, and MCP server use the same shared coordination server.

Personal agent execution remains developer-controlled and may run through Orca or another local execution environment. The shared server coordinates and observes runs but does not hold the developer's git credentials or execute agent commands itself.

GitHub is the first intended work-source family: Issues and pull requests provide actionable work, repository Milestones provide planning metadata, and selected existing GitHub Projects provide cross-repository planning views and fields. A GitHub App installed on selected repositories provides narrowly scoped issue and pull-request access; connecting organization-owned GitHub Projects additionally requires the organization's Projects permission and an explicit Collab-side project allowlist. The CLI authenticates to MTAAP rather than receiving GitHub App credentials. An official hosted service may be offered later, but the open-source self-hosted deployment must remain fully functional.

### Federated Source Model

MTAAP is a **federated command center**, not a central warehouse for issues, documents, and notes. Connected systems retain ownership of their native content and permissions. MTAAP stores external references, refreshable projections, relationships, explicit run-context snapshots, and its own coordination records.

Connected systems have distinct roles:

- **Work sources** provide actionable work items that can be created, triaged, and delegated. GitHub Issues and pull requests are the first actionable work items; GitHub Milestones and selected GitHub Projects supply authoritative planning containers and fields around them.
- **Context sources** provide documents and notes that can be searched, linked, and deliberately attached to a run. Outline is included in v1 as the first context source with bidirectional read and write support.
- **Execution environments** run personal agents and own live worktrees, terminals, and processes. Orca and a native CLI runner are the first execution targets.

The Obsidian connector is deferred until after v1 because Obsidian vaults are local and require a user-controlled local connector or plugin. MTAAP must not silently upload or centrally index a personal vault.

### GitHub Issues V1 Role

GitHub is authoritative for issue and pull-request content, permissions, and native state. MTAAP keeps a refreshable Source Projection of selected issue fields and mirrors GitHub's reported `OPEN` or `CLOSED` state honestly; it does not map that state into a competing MTAAP task lifecycle. Agent Run state, leases, progress, evidence, and approvals appear alongside the issue as a coordination overlay and never masquerade as GitHub state.

The server-side GitHub App receives signed webhooks for installed repositories and periodically reconciles active records through the GitHub API so a missed delivery cannot leave the projection silently stale. Actions initiated in Collab to create, edit, or triage an issue are sent to GitHub first and shown as successful only after GitHub confirms them. Pending or failed source mutations remain visibly pending or failed rather than being applied optimistically to the authoritative view.

When an Agent Run produces a pull request for an issue, MTAAP suggests a PR body containing the correct closing reference, such as `Closes OWNER/REPOSITORY#123`. GitHub closing keywords only link and auto-close the issue when the pull request targets the repository's default branch, and repository settings may disable auto-closing. MTAAP therefore never closes an issue merely because an Agent Run finished or a PR merged: it waits for GitHub to report the issue as closed. A merged PR with an issue that remains open is displayed exactly that way and flagged for attention rather than silently "fixed" by MTAAP. Reopening the GitHub issue likewise reopens its Source Projection without rewriting completed run history.

Each Agent Run has one explicit Run Goal and completes independently from the GitHub issue lifecycle. An implementation run may reach `COMPLETED` once it has delivered its PR reference and required verification evidence even though the PR is still under review and the issue remains open. Later review, fix, documentation, or follow-up work starts a new Agent Run with its own goal and terminal result, linked to the same issue, PR, and any predecessor run. Completed runs are immutable history; source events and follow-up work never reopen or repurpose them.

### GitHub Issue Mutation Surface V1

Collab supports the ordinary GitHub Issue workflow needed by a small development team: create an issue; edit its title and body; add comments; add or remove labels, assignees, and a milestone; add or remove it from an explicitly connected GitHub Project; and close or reopen it with GitHub's native state reason. These operations use the narrowly scoped GitHub App installation and require issue write access only for repositories deliberately connected to the Collab project. GitHub's repository rules, installation scope, valid assignees, available labels and milestones, connected-project allowlist, and API response remain authoritative.

Every mutation is submitted to GitHub before Collab updates its Source Projection. Additive operations such as a new comment use idempotency and duplicate detection. Replace-style operations such as editing a title or body carry the exact source revision, ETag, or expected prior value the member reviewed; Collab immediately refreshes and rejects the write as `SOURCE_REVISION_STALE` when the comparable value changed. Where GitHub exposes no atomic conditional-write primitive, Collab performs a final read-compare-write, labels the residual race as advisory, records both observed revisions, and never claims database-grade compare-and-set safety. The UI shows the initiating Collab member and the resulting GitHub actor, source timestamp, and outcome so the shared bot identity does not erase provenance. Conflicting or rejected edits are refreshed from GitHub and shown as failed rather than retried as an unqualified overwrite.

Organization issue types, sub-issues and relationships beyond advisory dependency projection, transfers, locking, reactions, pinning, and other expanding issue-management features remain read-only projections or links back to GitHub in v1. GitHub Projects and Milestones have the explicit operational surfaces below; their inclusion does not turn every GitHub feature into v1 scope.

### GitHub Milestones V1

Repository Milestones are an authoritative day-one planning surface. For every deliberately connected repository, Collab may list and inspect open and closed milestones; create one; edit its title, description, due date, and state; close or reopen it; and assign or unassign a milestone on an issue or pull request. GitHub remains authoritative for milestone numbers, state, due dates, valid repository scope, and derived open/closed issue counts.

Milestone mutations use the GitHub App's repository Issues write permission and follow the same confirm-before-projecting rule as issue edits. A failed or conflicting mutation refreshes the GitHub value and remains visibly failed; Collab never applies a local milestone state first. Deleting a milestone and bulk-moving its items remain GitHub-side operations in v1 because they are destructive or unusually broad.

The issue and pull-request views expose their milestone inline, while the GitHub planning surface supports filtering and grouping by milestone. A milestone does not become a Collab lifecycle, deadline policy, or automatic Agent Run completion condition merely because it has a due date or reaches zero open issues.

### GitHub Projects V1

V1 may connect selected existing organization-owned GitHub Projects as authoritative external planning containers. An owner chooses each exact GitHub Project during connector setup; discovery permission never means automatic ingestion of every project in the organization. Collab stores the selected project identifier, safe metadata, field definitions needed for projection, item references, supported field values, freshness, and mutation provenance rather than copying the project into a second backlog.

For issue and pull-request items belonging to repositories already connected to the same Collab Project, members may list and inspect project membership and field values; add or remove the item; update supported single-select, text, number, date, and iteration fields; and change item position when GitHub accepts it. Status is treated as an ordinary GitHub-owned single-select field, not as a hidden mapping to the Agent Run lifecycle. Every mutation is sent to GitHub first, schema-validated against the latest field definition, and projected only after confirmation.

The GitHub App requires the separate organization Projects read or write permission in addition to repository Issues and Pull Requests permissions. Connector setup explains that this may require organization-owner approval. Collab enforces the intersection of the exact selected GitHub Project allowlist and the exact connected repository allowlist: an item from another repository is represented only as a redacted unsupported reference and its content is neither persisted nor mutated, even if the organization-level Projects permission could return it.

Existing project field definitions and view names may be inspected and linked from Collab. The v1 GitHub planning surface may group issue and pull-request items by a selected supported field such as Status, and moving a card between those columns is an explicit, confirmed GitHub field mutation. This is separate from the operational Command Center lanes, which remain non-draggable projections of run and attention state.

Creating or deleting GitHub Projects, authoring or deleting fields and views, reproducing arbitrary saved-view layout and filter behavior, configuring built-in project automations, and creating, converting, or editing draft project items remain in GitHub for v1. Draft items may appear as read-only redacted or linked project entries but are not treated as GitHub Issues and cannot be mutated through the Collab Project surface.

Signed webhooks are consumed where GitHub exposes the required event, and periodic reconciliation remains mandatory for selected active Projects and Milestones because external changes and missed deliveries must converge. Project and milestone projections never drive Agent Run transitions unless a separately selected typed workflow condition explicitly references a currently refreshed authoritative value.

### Advisory Source Dependencies V1

When a connected work source exposes dependency or blocking relationships, Collab may show them as refreshable source-native projections on the issue, Coordination Record, and New Run composer. The source remains authoritative for the relationship and its current state; v1 does not create a parallel MTAAP dependency graph or infer dependencies from free-form issue text.

Before launching a source-backed Agent Run, Collab refreshes the projected dependencies when possible and visibly warns if any appear unresolved, unavailable, or stale. The warning identifies the source relationship and links back to its authoritative item, but it does not disable **Launch run** or require an override record. A member may deliberately start research, planning, preparatory implementation, or other useful work before a dependency is resolved.

Dependency state is included as timestamped context and provenance, not as an automatic Agent Run transition. A dependency later becoming blocked, resolved, or unavailable does not silently pause, resume, complete, or fail an existing run. Hard dependency enforcement, Collab-owned dependency editing, and dependency-driven scheduling are deferred until real small-team usage demonstrates that advisory visibility is insufficient.

### Assignment and Delegation V1

Collab treats human Assignment and agent Delegation as separate operations. **Assign** changes the authoritative GitHub assignee list and answers who is accountable for the issue. **Delegate to agent** creates a new Agent Run with an explicit Run Goal, runner, and Custom Launch Profile and answers which automated execution is currently pursuing work. Delegation never silently adds, removes, or impersonates a GitHub assignee, and an agent is not represented by a synthetic human owner.

The issue view presents both dimensions together: current GitHub assignees remain visible beside active and historical Agent Runs. A human may stay assigned while one or more sequential implementation, review, or fix runs operate on the issue; completed run history does not alter that human accountability.

The UI may offer an explicit **Assign and delegate** shortcut, but it submits two independently auditable operations. Each result is displayed separately, and partial success remains visible and retryable; Collab does not roll back a successful GitHub assignment merely because runner dispatch failed, or cancel a successfully created Agent Run merely because GitHub rejected an assignee change.

### Agent Run Lifecycle V1

The fixed v1 lifecycle is intentionally small:

```
QUEUED -> RUNNING <-> WAITING
             |           |
             +-----------+-> COMPLETED | FAILED | CANCELLED
```

- `QUEUED` means the run is durably created but no Execution Attempt has started its process.
- `RUNNING` means the run has begun pursuing its goal and is either executing an attempt or progressing through an automatic policy such as a durable managed-loop delay. It is not waiting for human input.
- `WAITING` means the run has a durable checkpoint, a reason and requested next action, and no process is being kept alive. A new Execution Attempt returns it to `RUNNING`.
- `COMPLETED` means the Run Goal's result and required evidence were durably recorded.
- `FAILED` means the Run Goal could not be achieved and no retry remains within this run.
- `CANCELLED` means an authorized human or policy intentionally ended the run.

An individual Execution Attempt may fail, time out, or disappear without making the Agent Run `FAILED` when another attempt can continue the same Run Goal. `COMPLETED`, `FAILED`, and `CANCELLED` are immutable terminal states; materially new work always creates a follow-up run.

### Run Results and Retry Budget V1

Every Agent Run snapshots a positive maximum Execution Attempt count and an absolute deadline, including a blank source-free run using the `ONCE` execution policy. `ONCE` means that Collab schedules no automatic iteration after a normally exited attempt; it does not mean that the run has no retry contract. The default maximum is one attempt. A Personal Run Preset, Team Run Template, or explicit composer choice may set a larger bounded budget for failed starts, lost attempts, checkpoint resumptions, or changes requested without turning the run into a Managed Loop.

An attempt that exits after doing useful work submits one canonical typed Run Result: `DELIVERED`, `NO_CHANGES`, `BLOCKED`, or `ESCALATED`, with a bounded summary and evidence references. `DELIVERED` and `NO_CHANGES` are claims evaluated against the Run Goal, required gates, authoritative predicates, and review policy; neither completes a run by itself. `BLOCKED` moves the run to `WAITING` only when it names a typed reason and next action. `ESCALATED` moves it to `WAITING` for a human decision. Missing or invalid results are a visible `RESULT_CONTRACT_VIOLATION`, never inferred from exit code or prose.

After an `ONCE` attempt exits, the coordinator completes or fails the run when the evidence and policy decide the goal, moves it to `WAITING` when explicit input or recovery is possible within the recorded bounds, or creates a replacement attempt only for a typed automatic retry allowed by the immutable retry policy. The retry policy may cover `FAILED_TO_START`, `LOST`, and explicitly retryable infrastructure failures with bounded backoff; it never retries an ambiguous agent result, a denied authority check, or an exhausted deadline. Every created attempt consumes the same recorded budget. Exhaustion ends the run as `FAILED` with a stable reason; continuing requires a follow-up Agent Run.

### Durable Checkpoints and Recovery V1

V1 stores durable structured checkpoints between Execution Attempts. A checkpoint records the Agent Run and attempt identifiers, reason, requested next action, structured progress summary, runner and worktree identity, current commit or Published Git Reference when available, bounded verification evidence, relevant source revisions, and the minimum explicit resume guidance needed by a later attempt. Human responses and policy decisions append to the checkpoint rather than rewriting its original state. The recovery surface always distinguishes runner-local state from the most recent Recoverable Remote Reference and shows that remote ref's commit, verification time, and age; when none exists, it says that continuation depends on the pinned runner instead of implying portable recovery.

After an agent process exits, crashes, or its runner daemon restarts, Collab may create a new Execution Attempt against the same Agent Run and runner-local worktree using the latest accepted checkpoint plus freshly assembled authorized context. Recovery resumes the durable goal and working state; it does not pretend to restore the prior process memory, terminal session, or exact model state. If the pinned worktree is unavailable, the existing runner-unavailable and published-artifact rules apply.

V1 does not provide full execution replay. It does not reconstruct terminal interaction, deterministically re-run historical model calls, or retain raw runtime transcripts merely for debugging. Historical attempt lifecycles, checkpoint records, safe evidence, configuration provenance, and git artifacts remain inspectable, which is sufficient to understand and continue ordinary runs without creating a second transcript-storage system.

### Execution Attempt Lifecycle V1

Each concrete process invocation beneath an Agent Run has its own fixed lifecycle:

```
PENDING -> STARTING -> RUNNING
                        |
                        +-> EXITED | FAILED_TO_START | CANCELLED | TIMED_OUT | LOST
```

- `PENDING` means the attempt was durably created and dispatched, but the selected runner has not acknowledged it.
- `STARTING` means the runner acknowledged the attempt and is preparing its worktree and process, but has not yet reported an operating-system process start.
- `RUNNING` means the runner reported that the operating-system process started.
- `EXITED` means the process ended. MTAAP records its exit code and termination signal, but a zero exit code does not by itself mean the Run Goal was achieved.
- `FAILED_TO_START` means the runner acknowledged the attempt but never started its process because setup, adapter, or worktree preparation failed.
- `CANCELLED` means an authorized cancellation ended or aborted the attempt.
- `TIMED_OUT` means the attempt exceeded its policy deadline and runner termination was attempted or confirmed.
- `LOST` means the runner became unavailable and could not reconcile the process state before the configured grace period expired.

`EXITED`, `FAILED_TO_START`, `CANCELLED`, `TIMED_OUT`, and `LOST` are immutable terminal attempt states. An attempt's exit status is evidence, not an Agent Run result: the shared server decides the corresponding run transition separately, and a failed attempt may be followed by another attempt pursuing the same Run Goal.

An Execution Attempt is measured as exactly one runner-supervised agent-runtime operating-system process or interactive session invocation. Its boundary begins when the server durably creates and dispatches the attempt and ends at one terminal attempt state. Reconnecting to the same still-running process does not create another attempt; launching another agent-runtime process after exit, retry, checkpoint, or resume does. Internal ticks of a Runtime-Owned Loop remain one attempt, while every agent-runtime process launched as a Managed Loop iteration is a separate attempt. A created attempt consumes the run's attempt budget even when setup fails before process start. A separate quality-gate process is measured as a Gate Evaluation, not as an Execution Attempt.

V1 never assigns an ambiguous `SUCCEEDED` or `FAILED` status to an Execution Attempt. The UI presents its exact lifecycle result and, when available, exit code, decoded Agent Outcome, and evidence as separate facts. `EXITED` with code zero means only that the CLI process ended normally; `GOAL_ACHIEVED` is an agent claim; neither independently completes the Agent Run. Only the coordination layer marks the Agent Run `COMPLETED` or `FAILED` after evaluating its Run Goal, required evidence, quality gates, authoritative source predicates, selected Stop Policy, remaining retry policy, and any required human decision.

A `LOST` attempt is never resurrected. If its runner later reconnects and discovers an orphaned process, it terminates or quarantines that process and reports the reconciliation outcome. Continuing the work requires a newly created Execution Attempt, preserving one durable and auditable history rather than rewriting what the server previously observed.

### Loop Execution V1

V1 supports two explicit forms of repeated agent work without pretending they have the same observability. A **Runtime-Owned Loop** is requested by the visible workflow instructions in a Personal Run Preset or Team Run Template, such as a Claude instruction that invokes `/loop`. Its selected runner-local Custom Launch Profile controls only how those effective instructions are delivered to the CLI. Collab starts and supervises the resulting process as one long-running Execution Attempt: internal ticks remain runtime behavior, while Collab observes the process, heartbeats, bounded logs, deadline, cancellation, exit, and any structured events the adapter can decode.

A **Managed Loop** is an opt-in Agent Run execution policy owned by Collab. The shared server durably schedules sequential Execution Attempts against the same Agent Run Worktree. Before each iteration it refreshes the relevant issue, pull-request, approval, and attached-context projections, includes the prior checkpoint and iteration evidence, and evaluates the loop's continuation and stop policy. Attempts never overlap, and the cadence delay is stored as a future schedule rather than keeping an agent process alive merely to sleep.

`ONCE` remains the default execution policy. It schedules one normal attempt and then follows the run's separately visible result and retry policy; a failed start, lost process, or checkpoint resume may consume another explicitly budgeted attempt without becoming a loop. Effective workflow instructions may still ask the runtime to perform a Runtime-Owned Loop inside one attempt. `MANAGED_LOOP` must be chosen explicitly and exposes each iteration, checkpoint, next scheduled time, and stop reason in the shared UI. Both modes remain one outcome-oriented Agent Run only while every iteration pursues the same Run Goal; a new goal creates a follow-up run rather than mutating the loop's identity.

The run stays `RUNNING` during a durable automatic managed-loop delay because no human action is required. It moves to `WAITING` only when continuation depends on human input or another non-scheduled external action, at which point no agent process remains parked. Cancellation prevents future iterations and terminates any currently active attempt through the normal runner path.

### Loop Bounds and Termination V1

V1 has no unbounded loop mode. Every Managed Loop must define all three of: a semantic stop condition tied to its Run Goal, a positive maximum number of Execution Attempts, and an absolute wall-clock deadline. Every created attempt counts against the maximum, including failed starts, lost processes, and retries, so infrastructure trouble cannot accidentally reset the budget. The server evaluates the stop condition and remaining bounds before creating each next attempt.

A Runtime-Owned Loop has opaque internal ticks, so Collab cannot honestly enforce an iteration count or interpret its internal completion rule. It must still have a positive absolute deadline carried in the execution policy and enforced by the runner even while disconnected from the server. Reaching that deadline terminates the process through the normal cancellation path and records the attempt as `TIMED_OUT`.

Runner owners may configure profiles with generous duration ceilings and a self-hosted deployment may raise its allowed ceilings, but neither can represent infinity, omit the final deadline, or use a sentinel value that disables enforcement. A dispatch may choose only limits within the stricter profile and deployment ceilings. The effective bounds are recorded with the Agent Run so later configuration changes do not silently widen work already in progress.

When a semantic stop condition is satisfied, no further attempt is scheduled and the normal goal-result evaluator records whether the Agent Run is `COMPLETED`. When an attempt limit or deadline is exhausted before goal completion, the run terminates as `FAILED` with a stable limit reason and preserved evidence. Continuing after exhaustion requires an explicit follow-up Agent Run with new bounds; a human acknowledgement never resurrects or rewrites the terminal run.

### Managed Loop Stop Policies V1

A Managed Loop uses a versioned, declarative Stop Policy evaluated by the shared server before the first attempt and between later attempts. The policy is a typed condition tree built from `ALL`, `ANY`, and `NOT`; source predicates for GitHub issue state, linked pull-request state, checks, unresolved major reviews, and approval state; a canonical Agent Outcome predicate; and `CONSECUTIVE_MATCHES(condition, count)` for rules such as three clean rounds. Parameters use validated identifiers and enum values rather than interpolated expressions.

The server refreshes the relevant Source Projections before evaluation and records the predicate inputs, result, consecutive-match counters, evaluation time, and resulting action as loop evidence. `CONSECUTIVE_MATCHES` state is durable across server restarts and increments only once per completed managed iteration. The evaluator produces explicit `TRUE`, `FALSE`, or `UNKNOWN` results instead of guessing when required source facts are unavailable.

An Execution Adapter may normalize runtime output into one canonical Agent Outcome event: `CONTINUE`, `GOAL_ACHIEVED`, or `ESCALATE`, accompanied by a reason and evidence references. This event has no special authority unless the selected Stop Policy includes it. `GOAL_ACHIEVED` may satisfy a completion branch; `ESCALATE` ends automatic iteration and moves the run to `WAITING`; neither can bypass hard Loop Bounds or directly rewrite GitHub or Agent Run state.

Stop Policies contain no JavaScript, shell, regular-expression command execution, runtime-specific flags, or arbitrary adapter payload conditions. The web, CLI, and MCP surfaces may offer named templates that compile to the same typed policy schema, preserving one inspectable and testable evaluator rather than several automation languages.

### Unknown Stop-Policy Inputs V1

Stop Policy evaluation uses three-valued logic so a missing fact matters only when the final result actually depends on it: `TRUE OR UNKNOWN` is `TRUE`, `FALSE AND UNKNOWN` is `FALSE`, and otherwise uncertainty propagates to the root. A source predicate evaluates to `UNKNOWN` when its required projection cannot be refreshed within its freshness requirement, rather than treating stale data as current. An unknown iteration neither increments nor resets a `CONSECUTIVE_MATCHES` counter.

When the root result is `UNKNOWN`, Collab fails closed and does not create another Execution Attempt. It records the unavailable inputs and automatically retries their source refresh with bounded exponential backoff and jitter. The Agent Run remains `RUNNING` during this configured recovery grace period, with its next refresh time visible, because no human action is yet required and no agent process is kept alive.

If the root remains `UNKNOWN` past the grace period, the run moves to `WAITING` with reason `SOURCE_UNAVAILABLE` and the project receives an in-product notification. A later successful webhook or reconciliation refresh automatically re-evaluates the policy and returns the run to `RUNNING` when it is safe to continue; a human does not have to acknowledge a transient outage merely to resume automation.

The absolute Loop Bounds deadline continues throughout retry and `WAITING`. If it expires before trustworthy source data returns, the run terminates as `FAILED` with the deadline reason. Neither automatic recovery nor a source reconnection may extend the recorded bounds.

### Agent Run Worktree Ownership V1

One Agent Run owns one dedicated git worktree and branch on its local runner. The runner creates that worktree when the first Execution Attempt starts and every later attempt within the same run reuses it, preserving uncommitted edits, commits, and local verification state across retries, checkpoints, and loop iterations. A failed attempt never implies that its worktree changes should be discarded.

Execution Attempts within one Agent Run are sequential. At most one attempt may hold the run's worktree lease in `STARTING` or `RUNNING`; a later attempt remains `PENDING` until its predecessor reaches a terminal attempt state. The shared server is authoritative for this lease, while the runner stores only an opaque local worktree identifier in coordination events and never exposes its absolute filesystem path.

Separate Agent Runs always receive separate worktrees, even when they refer to the same GitHub issue, pull request, or predecessor run. This keeps review and fix work independently auditable and prevents two durable goals from silently sharing mutable local state.

An Agent Run becomes pinned to its selected Registered Runner when that runner creates the run's worktree. Before then, a `PENDING` attempt may be cancelled and retargeted because no runner-local working state exists. After pinning, every later Execution Attempt for that run must execute on the same runner; v1 does not pretend that uncommitted files, ignored files, local tool state, or credentials can migrate safely between machines.

If the pinned runner becomes unavailable, the active attempt may become `LOST` and the Agent Run moves to `WAITING` with `RUNNER_UNAVAILABLE` as its durable reason. It may resume through a new attempt when the same runner reconnects. Continuing on another runner requires a new follow-up Agent Run based on an explicit durable git artifact, such as a commit or branch reachable from a shared remote. Any state that existed only in the unavailable worktree is reported as unavailable rather than reconstructed from logs or server data.

Terminal Agent Runs do not retain worktrees merely for historical inspection. After a run reaches `COMPLETED`, `FAILED`, or `CANCELLED`, the runner automatically removes its worktree and local run branch when all of the following are true: no Execution Attempt is active, the tracked and untracked working tree is clean, and the runner has verified that the worktree's `HEAD` is reachable from the Published Git Reference on the configured remote. A pull-request merge is not required; a verified push is sufficient because the remote commit and branch are the durable handoff.

Before removal, the runner reports the remote URL identity, remote ref, commit SHA, verification time, and clean-tree result as structured evidence, then records whether cleanup succeeded. It never uploads the worktree contents to MTAAP. Ignored files and generated artifacts inside a managed Agent Run Worktree are disposable and do not block cleanup; projects must keep durable inputs outside managed worktrees or commit them deliberately.

If the worktree is dirty, contains untracked files, has commits not verified on the remote, or cleanup itself fails, the runner retains it and surfaces an explicit cleanup action instead of guessing that the remaining state is expendable.

Dirty or unpublished terminal worktrees have no automatic expiry in v1. MTAAP shows their age, disk usage, branch, commit status, and changed-file summary to project members, but only the Registered Runner's owner may authorize destructive cleanup on that machine. Other members may request cleanup but cannot discard the runner owner's local state.

For a clean worktree whose commits are not yet published, the owner may choose **Publish**, which asks the runner to push the existing local branch through its configured git credentials and then reruns the cleanup checks. Publish never invents a commit from dirty files. For a dirty worktree, MTAAP offers **Open locally** and **Discard**; Discard requires an explicit confirmation after showing uncommitted files and unpushed commits, removes the local worktree, and records an auditable destructive-cleanup event without uploading file contents.

### Work Item Mutation Guard V1

Every Agent Run declares a Repository Mode of `MUTATING` or `INSPECT_ONLY` and a Repository Assurance of `ADVISORY` or `ENFORCED` when it is created. A `MUTATING` run may change files, commits, branches, or pull-request code only while it holds live authority. An `INSPECT_ONLY` run receives no Collab mutation lease, connector-write authority, or publish operation and the runner reports any worktree change as an explicit policy violation rather than silently promoting it to mutating.

Repository Mode is not a sandbox claim. The trusted Native and Orca hosts execute as the runner owner's operating-system user and normally provide `ADVISORY` assurance: a dedicated worktree and withheld Collab capabilities coordinate compliant adapters but cannot prevent arbitrary local commands from editing other paths or using owner credentials directly. The composer, run card, workflow binding, and audit evidence display that fact. A Team Run or Workflow Template may require `ENFORCED` assurance; launch then succeeds only on a runner adapter that can technically prevent the prohibited filesystem, git, network, credential, and connector operations. V1 fails closed rather than labeling a trusted unsandboxed process enforced.

The shared server applies one Work Item Mutation Guard to each Coordination Record, covering a GitHub issue and any pull requests linked to that same coordinated work. By default, only one non-terminal `MUTATING` Agent Run may reserve the guard; `QUEUED`, `RUNNING`, and `WAITING` runs retain that reservation, while the active attempt must also renew a short live mutation lease before mutating or publishing. Concurrent `INSPECT_ONLY` review and triage runs do not consume the guard. Their safety on an `ADVISORY` host is coordination isolation and visible policy evidence, not a hard guarantee against a malicious or defective local process.

Any project member may explicitly override the guard for an intentional parallel implementation or experiment. The override records the actor, reason, time, and colliding runs; every overridden run still receives its own branch, worktree, runner pin, and lifecycle. The web, CLI, and MCP surfaces display the overlap prominently until all but one mutating run become terminal. MTAAP never performs an implicit override merely because another runner is available.

`MUTATING` Agent Runs attached to different Coordination Records in the same repository are allowed by default. Sharing a base branch is normal and does not constitute a collision because every run changes code on its own generated branch in its own worktree. This preserves the parallelism that makes the product useful instead of serializing an entire repository behind one active issue.

The shared server hard-blocks dispatch only when another non-terminal Agent Run already claims the exact same local or intended remote head branch. Branch names generated by MTAAP include the Agent Run identity so this should be exceptional; a user-supplied colliding branch must be changed or explicitly attached to the existing run rather than shared by two runs.

When changed-file metadata later shows that otherwise independent runs overlap, MTAAP raises a visible Repository Collision warning on both runs. The warning does not cancel, pause, or merge either run; their worktrees remain isolated and the humans or agents decide whether to continue, coordinate, or stop one of them.

Each runner produces a Changed-Path Snapshot at every durable Agent Run checkpoint, whenever an Execution Attempt exits, and immediately before publish. It derives the complete set from changes between the run's recorded base commit and `HEAD` plus current staged, unstaged, and untracked files, so committed work does not disappear from collision detection. Renames contribute both their old and new paths.

A snapshot contains only its project and run identifiers, base commit SHA, observation time, and a bounded set of normalized repository-relative paths. Paths use `/` separators; absolute paths, parent traversal, control characters, and values over the protocol limits are rejected. The runner never sends file contents, diffs, line numbers, path hashes, ignored-file names, or machine-local worktree paths. When the safe path-count or payload limit is exceeded, it reports a truncated snapshot explicitly and MTAAP marks collision detection incomplete rather than assuming no overlap.

The shared server keeps only the latest accepted snapshot needed for each relevant run, compares snapshots only within the same connected repository, and exposes them only to authorized project members. A path intersection creates or updates a Repository Collision warning; the pre-publish check remains advisory and does not silently block a push that the run is otherwise authorized to perform.

The latest Changed-Path Snapshot remains available while its Agent Run is non-terminal. Once the run becomes terminal, MTAAP retains the snapshot only while at least one linked pull request remains open or the runner still reports Retained Local Work. Those are the periods when the run's unmerged or unpublished changes can still collide with new work.

GitHub webhook reconciliation and runner cleanup events both re-evaluate this retention condition. When no linked pull request is open and no Retained Local Work remains, the server purges the path set on its next reconciliation; it does not preserve checkpoint-by-checkpoint path history. Published diffs remain available from GitHub, and a still-retained worktree can produce a fresh snapshot, so MTAAP does not need a permanent duplicate.

Purging the Changed-Path Snapshots does not erase the fact that a Repository Collision occurred. MTAAP retains a path-free Collision Audit Record containing only its project and connected repository identifiers, the two Agent Run identifiers, first and last detection times, maximum observed overlap count, and any acknowledgement or resolution status with its actor and time. It contains no paths, branch names, commits, diffs, file contents, or reconstructable path hashes.

The Collision Audit Record follows the normal durable coordination-history retention policy. Its purpose is to explain why a warning, override, cancellation, or human decision occurred; it cannot be used to recreate the deleted repository structure or perform future collision detection.

### Federated Search V1

Unified search fans a query out live to the connected work and context sources, beginning with GitHub Issues and Outline. MTAAP normalizes the returned titles, snippets, source types, update times, and external references into one result list without copying the sources' full content into a central index. It may keep short-lived metadata and snippet caches, but selecting a result retrieves the current content and permissions from its authoritative source.

Connector failures produce explicit partial results rather than failing the entire search or silently serving stale full-text copies. A local semantic or full-content index is deferred until after v1 and, if added, must remain optional and permission-aware.

### Outline V1 Role

Users must be able to search, read, create, edit, and iteratively refine Outline-backed documents from the Collab web interface. Successful writes are persisted to Outline, which remains authoritative for document content, revisions, collections, and permissions.

Each connected Outline workspace uses one MTAAP Bot Identity for agent reads and writes. Human edits initiated through Collab use that member's delegated Outline OAuth identity instead, so the Integrations and editor surfaces must show the active human identity, granted scopes, expiry or refresh health, and a visible **Revoke** action rather than presenting every edit as the bot. A member without a healthy delegated grant may still read through the project bot where policy permits, but cannot silently perform a human-attributed write; Collab offers reconnect or an explicitly labeled bot-authored proposal path. Outline therefore distinguishes human changes from automation, while MTAAP's audit trail maps each bot-authored operation to the exact Agent Run, Execution Attempt, human grantor, and source revision. Bot and delegated credentials remain encrypted server-side and are never exposed to personal agent runtimes; the native Outline permissions of the selected identity and the project's Context Read Scope jointly bound what it can access.

Each project defines a Context Read Scope by allowlisting Outline collections. Agent Runs may search and read documents inside that scope without per-document approval. The allowlist is a ceiling rather than a new permission source: Outline's native permissions still apply, and documents outside the configured collections are invisible to the project. Each retrieved document and source revision is recorded in the run's provenance, while write access remains governed separately by Document Write Grants.

MTAAP may retain an explicit pending change, the Outline document reference, and the source revision used to prepare the change. It must not maintain a silently diverging canonical copy of the document.

Document review is asynchronous and must not keep the originating agent process alive. Once an agent durably submits a pending change, it can continue its task or complete its run without waiting for a human. A later approval is applied independently; a conflicting source revision creates a focused follow-up rather than attempting to resume a long-idle process. Only an explicit decision that blocks the underlying task may suspend progress, and that suspension must be represented as a durable checkpoint rather than a parked runtime.

Agent-authored Outline changes require approval by default. A human may explicitly grant an agent write scope over named existing documents; within that scope, the agent may make repeated non-destructive content edits without per-change approval. Documents outside the scope continue through the asynchronous proposal queue. Creating documents, moving or archiving them, deleting them, and changing sharing or permissions remain approval-gated even when content editing is granted. A concurrent external edit invalidates the direct-write path and turns the agent's next change into a reviewable conflict instead of silently overwriting the newer source.

Before every granted write, MTAAP refreshes the document and compares its current source revision with the revision the Agent Run edited. If they differ, v1 never overwrites or auto-merges the content. It stores the base and current source references and revisions plus the bounded agent-authored proposed change or patch as a conflict proposal that a human can edit, apply, reject, or hand to a focused follow-up run. Fetched base and current document bodies remain in Outline and are retrieved on demand when an authorized member resolves the conflict; they are not copied into coordination tables, audit payloads, logs, backups, or runner outboxes. The originating run continues or completes independently. Automatic document merging is deferred until real conflict patterns justify the additional machinery.

MTAAP serializes its own bot writes per document and records the pre-write and returned source revisions. This prevents races between MTAAP operations but cannot lock a human editing directly in Outline, so Outline's revision history remains the recovery path for the narrow race between the final revision check and the external write.

A Document Write Grant belongs to one durable Agent Run. The run may contain one execution or many loop iterations, restarts, and resumptions; those Execution Attempts retain the grant because they share the same run identity. A separate reviewer, replacement, or follow-up run does not inherit it.

Any Collab project member may issue or revoke a Document Write Grant for documents within the project. V1 does not replicate Outline's per-user ACL checks inside MTAAP; project membership is the trusted collaborator boundary for this small-team product. The MTAAP Bot Identity's actual Outline permissions remain the hard ceiling, so a grant cannot make an otherwise unauthorized write succeed. Finer-grained grant roles may be added later if real usage requires them.

Disconnecting Outline, narrowing an allowed collection, revoking the bot credential, or revoking a member's delegated OAuth grant increments a connector authority epoch. New reads, writes, proposals, and unused run capabilities outside the new intersection fail immediately. Before an owner commits a scope reduction, Collab previews affected active runs, Document Write Grants, pending changes, and working documents. After commit, active runs retain their local reasoning but lose the affected connector operation: a required source action moves the run to `WAITING` with `CONNECTOR_SCOPE_REVOKED`, while optional work continues in proposal-only mode. Pending writes are never replayed under a broader or different identity; a member must refresh, reauthorize, and explicitly resubmit against the current source revision.

Every true external Outline write rechecks the current connector epoch, identity grant, collection scope, Document Write Grant, and exact document revision immediately before the API call. A raced native Outline edit becomes a conflict proposal. A raced scope or identity revocation becomes a denied operation. Collab records that it requested cancellation or denial but never claims that an unreachable local agent process stopped merely because server authority was revoked.

An agent may request additional named documents during a run. The request is non-blocking and confers no write access until a human approves it with a one-click action. Approval extends the existing run's Document Write Grant; rejection leaves the agent in proposal-only mode for that document. The agent continues other work while the request is pending, and if the underlying task truly cannot proceed, it creates a durable checkpoint instead of keeping an execution process parked.

An Agent Run may optionally have one External Working Document in Outline. It is an explicitly enabled, human-visible and co-editable canvas for a loop, not a default artifact created for every run or iteration. Private runtime state, logs, and checkpoints remain in MTAAP. When the run ends, the working document remains non-authoritative until a human deliberately retains it as working material, refines it into durable knowledge, or archives it.

Finishing a run with an External Working Document presents three one-click dispositions: **Keep as working material**, **Promote to durable knowledge**, or **Archive**. Keep is the non-destructive default when the user takes no action. Promote is an explicit human action that may rename or move the document into its durable Outline location; Archive is likewise an explicit human-authorized source operation. V1 has no automatic deletion, retention scheduler, or unattended scratchpad cleanup.

### Connector Authority and Revocation V1

Every GitHub App installation scope, selected repository, selected GitHub Project, Outline workspace, Outline collection, bot credential, and delegated member grant contributes a versioned connector epoch to authority decisions. Owners can preview a connector change before committing it. The preview lists projections that will become stale or redacted, active Run Capabilities, pending source writes and proposals, Document Write Grants, workflows whose predicates depend on the source, and attempts that will lose required operations; it reveals no source content outside the current scope.

Committing a disconnect or scope reduction first increments the affected epochs and denies new operations, then revokes unused permits and queued connector writes, marks projections stale or redacted, and sends bounded capability-update or termination requests to connected runners. An active run that can finish without the connector continues with reduced authority. A required connector dependency moves the run or workflow to `WAITING` with a stable revocation reason and no parked process. Proposal-only local content may remain as bounded authored evidence, but it is never applied automatically after reconnect; an active member must reauthorize and resubmit against current scope and source revision.

Every external mutation checks the current connector epoch and exact resource revision immediately before the provider call. GitHub or Outline can still change in the narrow interval after that check where the provider lacks atomic conditional writes, so Collab records the residual race and reconciles the authoritative result instead of claiming serializable external transactions. Restore, credential rotation, member offboarding, and provider-side revocation all use the same epoch mechanism.

### Packaging V1

V1 ships exactly two installable artifacts from one repository and build system. **`collab-server`** is one always-on container containing the web interface, authenticated API and MCP endpoint, GitHub and Outline connectors, webhook handlers, durable scheduler, coordination engine, SQLite migrations, and backup hooks. These remain logical modules with explicit interfaces inside the codebase, but they share one deployment lifecycle and persistent volume rather than becoming separate web, worker, connector, or MCP services.

**`collab`** is one local executable installed on each trusted developer machine. Its interactive commands, background runner daemon, OS credential-store integration, project registry, worktree manager, durable outbox, and Bundled Execution Adapters share the same installation. `collab runner` controls the local service, while `collab mcp` provides a local stdio bridge for agent clients that cannot connect directly to the server's authenticated MCP transport; the bridge contains no separate coordination logic.

The repository may retain separate server, local-client, protocol, domain, connector, and adapter source modules and directories for testability and ownership, but all remain inside the one root package and build graph. Module boundaries do not imply more operational components. The server and local executable use a versioned protocol handshake and may be upgraded independently only within an explicitly supported compatibility range.

V1 requires no Redis, message broker, external worker fleet, separate frontend hosting, separate MCP deployment, or server-hosted execution pool. A small team operates one server container plus one `collab` installation per trusted machine; later scale may split internal modules without changing their semantic contracts.

### Canonical Installation V1

The supported server path is a versioned Docker Compose bundle followed by a browser-based first-run wizard. Compose declares the single `collab-server` image, persistent data volume, health check, published port, backup location, and required secrets without requiring users to assemble internal services. The wizard configures the public base URL, initial owner, project defaults, authentication, and GitHub and Outline connectors; optional connectors may be completed later.

An unclaimed deployment cannot be claimed merely by reaching its public URL. First boot creates or consumes a one-time bootstrap secret available only through the local Compose environment or server logs, and the wizard requires it before creating the initial owner. The secret expires permanently after successful setup and cannot be regenerated through an unauthenticated web request. This keeps it safe to complete setup through Tailscale, Cloudflare Tunnel, or another reverse proxy without creating a race for administrative ownership.

On a trusted developer machine, the canonical flow is to download `collab`, authenticate it to the chosen server, and run `collab runner install`. The command registers the runner and installs a user-level background service using LaunchAgent on macOS or a systemd user service on Linux without requiring root. `collab runner start` runs the identical daemon in the foreground for development, diagnostics, and unsupported service managers.

V1 documents the Compose and user-service paths as the supported operational contract. Kubernetes manifests, Helm charts, manually maintained service units, and alternate orchestrators may be community-provided, but they do not expand the core project's compatibility or support surface.

### Authentication Architecture V1

Collab always authenticates a concrete Collab Member and issues its own application session. Network reachability through localhost, a private LAN, Tailscale, Cloudflare Tunnel, or another reverse proxy never becomes authorization by itself, and v1 has no `AUTH_DISABLED` mode. Multiple login providers may be enabled simultaneously without changing project membership, roles, grants, approvals, or audit attribution.

V1 supports three authentication provider classes. `LOCAL` verifies credentials held by Collab. `OIDC` accepts a configured standards-compliant issuer and validates its authorization response, issuer, audience, state, nonce, signature, expiry, and subject. `AUTH_PROXY` accepts identity only through an explicitly configured provider verifier: Cloudflare Access requires cryptographic validation of its assertion and expected issuer and audience, while Tailscale Serve headers require the origin to be unreachable except through the trusted local proxy path. Tailscale Funnel traffic has no Tailscale identity assertion and therefore uses another Collab login method.

Every verified provider identity maps to an internal, immutable Collab Member identifier before a session is issued. An upstream email address or group does not silently create project membership or grant permissions, and identities from different providers are never auto-linked merely because their email strings match. Joining and identity linking require an invitation, the first-run bootstrap flow, or confirmation from an already authenticated account.

All browser providers converge on the same secure session and revocation machinery, CSRF protection, audit actor, and reauthentication rules. CLI, MCP bridge, and runner authentication continue to use their scoped device and capability credentials rather than borrowing a browser cookie or trusting proxy headers forwarded by an agent process.

### Break-Glass Owner Recovery V1

Every deployment retains a host-controlled recovery path even when ordinary `LOCAL` web login is disabled. Recovery is initiated only from inside the server container, for example with `docker compose exec collab-server collab-server auth recover --member <member>`. There is no authenticated or unauthenticated network API that generates recovery credentials, and possession of an OIDC or proxy identity alone cannot invoke it.

The command selects an existing owner and prints one high-entropy, single-use recovery code to its invoking terminal. Only a hash, ten-minute expiry, target member, and generation audit record are persisted; the raw code is not written to normal service logs. Generating a new code invalidates any previous unused code for that owner. First-owner creation remains the separate one-time bootstrap flow and cannot be recreated through recovery.

Redeeming the code creates a short-lived recovery session that may repair login-provider configuration, link a new verified identity, or restore an ordinary local credential for that existing owner. It does not silently create members, change project grants, or disable other sessions. Generation is audited as a host recovery action and successful redemption is attributed to the recovered owner.

An operator may disable the ordinary `LOCAL` login form after another provider works, but cannot disable the container recovery command or represent a deployment with no recovery path. If an identity-aware proxy blocks the recovery URL, the owner must reach the origin through the same host-level access that authorized generation; Collab does not weaken the proxy automatically.

### Local Passkey Authentication V1

Ordinary `LOCAL` authentication is passwordless in v1 and uses WebAuthn passkeys with user verification required. A Collab Member may register and name multiple platform or roaming credentials, inspect their creation and last-used times, and revoke them individually. Collab stores the credential identifier, public key, signature-counter state, and required protocol metadata; biometric material and private keys never leave the member's authenticator.

Each member may also generate a set of high-entropy, single-use recovery codes. Only salted hashes are stored, the clear codes are shown once, redeeming one invalidates that code, and generating a replacement set invalidates every unused code in the previous set. Recovery-code use creates an auditable short-lived recovery session and requires the member to register a new passkey before returning to ordinary use. Owners retain the separate host-level break-glass path.

Passkey registration and authentication use the configured public base URL as the exact expected origin and a deliberately configured WebAuthn Relying Party ID. The wizard permits HTTPS origins or the localhost development exception and warns that changing the effective domain invalidates existing local credentials. Such a change requires another already-linked provider, a member recovery code, or host-level owner recovery to register replacement passkeys.

V1 does not store passwords, implement TOTP, send password-reset email, or use security questions. `OIDC` and `AUTH_PROXY` remain independent alternative login providers rather than weaker fallbacks disguised as local credentials.

### Team Invitations V1

Only an existing owner may create, inspect, or revoke a pending team invitation or remove a member. Creating an invitation records the intended team, inviter, `MEMBER` role, optional human label, creation time, and short expiry, then produces one high-entropy, single-use link for the owner to share through a trusted channel. Outbound email is not required; a future or optionally configured delivery mechanism may transport the same link without changing invitation semantics.

The invitation secret is placed in the URL fragment so it is not sent in the initial HTTP request, proxy logs, or referrer. The web client immediately exchanges it through a protected POST for a short-lived, HTTP-only invitation session, while the server stores only the invitation-token hash. The session authorizes only completion of that specific invitation and is neither a Collab login session nor a reusable bearer credential. Expiry, revocation, or successful use invalidates it permanently.

Before acceptance, the invitee sees the deployment, team, inviter, `MEMBER` role, and expiry. They then either register a local passkey or authenticate through an enabled `OIDC` or `AUTH_PROXY` provider. Only after successful authentication does Collab create or bind the immutable Collab Member Identity, add the team membership, consume the invitation, and issue the ordinary application session. Possessing an upstream identity without an invitation never joins the team.

The acceptance, expiry, revocation, and resulting membership are audited. After onboarding, the welcome flow offers the authenticated CLI device-pairing command and runner installation instructions; joining the team never silently registers a machine or exposes a runner.

### Team Roles V1

V1 has exactly two team roles: `OWNER` and `MEMBER`. A deployment may have multiple owners with no arbitrary seat ceiling and must always retain at least one. The first-run bootstrap member is the initial owner; later owners share administrative authority rather than acting as delegates of a permanent super-owner.

An `OWNER` manages authentication-provider configuration, connectors and their repository, GitHub Project, and context scopes, invitations, membership and role changes, team and project settings, and other deployment-level security choices. A `MEMBER` has full day-to-day collaborative authority inside every project, including supported GitHub issue, pull-request, Milestone, and connected-Project mutations, Outline collaboration and grants, approvals, Agent Run delegation, and use of explicitly Shared Runners. V1 has no admin, editor, viewer, billing, or custom-role matrix.

Runner ownership remains personal rather than role-derived. Becoming an owner does not expose another member's local credentials, private runners, profiles, or retained worktrees, and a member continues to control their own runner after promotion or demotion. Every role change is audited, and the server rejects removal or demotion of the last remaining owner.

### Owner Promotion V1

An invitation always admits its holder as `MEMBER`; v1 has no direct owner invitation. After the identity is accepted and visible in the membership list, any existing owner may promote that member through a separate privileged action. This ensures that a leaked invitation cannot immediately cross the deployment-administration boundary and lets the promoting owner verify the concrete identity being elevated.

Promotion and owner demotion require fresh passkey verification from the acting owner, not merely possession of an existing browser or identity-proxy session. A member must register at least one local passkey before becoming an owner, even if their ordinary login uses `OIDC` or `AUTH_PROXY`; ordinary local login may remain disabled while that passkey is retained for privileged reauthentication and recovery.

The role change takes effect immediately for subsequent authorization checks and records the actor, target, previous role, new role, time, and authentication method. The target is notified, multiple owners may coexist, and the invariant preventing removal or demotion of the final owner remains enforced transactionally.

### Member Offboarding and Authority Revocation V1

Removing a member is one privileged, transactional security operation, not just deletion from a list. The confirmation view previews the member's browser sessions, CLI and MCP devices, runner identities, Team Dispatch Exposures, connector grants, Document Write Grants, pending approvals, active or waiting Agent Runs they dispatched, workflow executions that retain them as original dispatcher, and Retained Local Work. The final owner invariant is checked before any revocation begins.

On commit, Collab marks the membership revoked; ends browser, recovery, CLI, MCP, runner, and refresh sessions; invalidates unused Dispatch Permits and Run Capabilities; revokes delegated Outline OAuth grants, Document Write Grants issued by that member, and pending approvals; increments the member authority epoch; and prevents new attempts or workflow steps from using that member as dispatcher. Active attempts dispatched by that member receive a terminate-and-checkpoint request. Confirmed termination records `CANCELLED`; an unreachable process is reported as unconfirmed and later becomes `LOST` under the normal grace policy. The product never equates revoked server credentials with proof that arbitrary code on an unreachable trusted machine has stopped.

An affected Agent Run stays as immutable history and moves to `WAITING` with `DISPATCHER_OFFBOARDED` when continuation remains meaningful. Another active member may explicitly **Adopt as follow-up**, which creates a newly authorized Agent Run or Workflow Execution from the latest Published Git Reference or other Recoverable Remote Reference. The new actor never inherits the removed member's approvals, connector grants, permits, personal preset bindings, or runner-local-only state.

If the removed member owns a Registered Runner, its identity, outbound WSS connection, runner epoch, project mappings, and Team Dispatch Exposures are revoked together. Active attempts receive the same best-effort termination path; private profiles and filesystem paths remain undisclosed. Worktrees stay on that machine under its operating-system owner's control. Collab may retain path-free evidence and remote references, but it cannot discard, migrate, or promise recovery of runner-local work after offboarding.

### Single-Team Deployment V1

One `collab-server` deployment represents exactly one trusted team containing any number of projects. The first-run bootstrap creates that team and its initial owner. A solo developer uses the identical model as a one-member team; there is no separate personal-account domain model.

The team retains an opaque internal identifier in storage, protocol messages, audit records, and `.collab/config.toml` so identifiers remain explicit and a future migration is possible. It is not a routing key supplied by callers: v1 has no team switcher, cross-team membership, tenant-selected URLs, tenant headers, or per-request tenant discovery. Authentication and capability tokens are issued for one deployment and cannot select another team namespace.

Collab Projects remain the organizational and connector-scoping unit inside the team. One GitHub App installation or Outline connection may expose different repositories, selected GitHub Projects, or collections to different Collab Projects without creating another identity tenant. Backups and restores cover the whole team because SQLite remains one authoritative deployment store.

A genuinely separate trust group, client, or company uses another server container, persistent volume, base URL, authentication configuration, and connector credentials. V1 does not attempt logical tenant isolation inside one process; this is a deliberate removal of the old SaaS architecture rather than an undocumented limitation.

### Team-Wide Project Access V1

Team membership grants visibility and collaborative access to every project in the deployment. V1 has no project-membership table, project invitation, per-project role, private project, or project ACL. Projects organize repositories, context scopes, runs, and coordination records; they do not subdivide the team's human trust boundary.

All active members may use the supported issue, document, approval, delegation, and coordination operations in every project. Owners remain responsible for adding or removing projects and configuring connector scopes because those choices widen the team's external data boundary. Distinct human access requirements use a separate Single-Team Deployment rather than exceptions inside one database.

External and local ceilings remain explicit. GitHub App installation permissions, connected-repository scope, selected GitHub Project allowlists, Outline Context Read Scopes, and source permissions still bound what any Collab Project can reach. A Registered Runner remains private unless its owner exposes selected profiles to selected projects as a Shared Runner; team-wide project access never converts personal execution infrastructure into a team-wide resource.

### Source Membership Alignment V1

Collab team membership is the deliberate human trust grant for everything connected to the Single-Team Deployment; it is not derived from or continuously synchronized with GitHub repository membership. Inviting a member therefore warns the owner that the member will see and operate on every connected project's projected source data. Connecting a repository likewise requires an owner to confirm that every current and future team member is intended to receive that access.

V1 does not require a personal GitHub identity to join, block onboarding or repository connection on a collaborator-role check, modify GitHub organization membership, or maintain a duplicate cross-system access matrix. This keeps authentication source-neutral and avoids coupling the team model to GitHub before later Work Sources exist. The intersection of the GitHub App installation permissions, selected repositories, and selected GitHub Projects remains the hard ceiling for what the shared server can read or mutate.

A member may optionally link a verified GitHub identity for GitHub assignee matching, attribution context, and an advisory access-health display. A mismatch is visible to owners but does not silently remove or suspend team membership. Human-initiated source mutations remain attributed to the Collab Member in MTAAP even when GitHub records the shared App actor.

Code execution uses a separate local authority check. Before a mutating Execution Attempt starts, the selected runner performs safe repository-access preflight using its own local git and GitHub credentials. If the required repository access is unavailable, preparation fails with a sanitized `REPOSITORY_ACCESS_DENIED` result before the agent process starts. Sharing a runner for a project is the runner owner's explicit acceptance that its local credentials may be used for authorized team dispatches.

### Notification Inbox V1

V1 has one durable, per-member Notification Inbox rather than separate notification systems for each feature. Inbox items are derived from authoritative coordination and source events and link back to their subject; they do not become another workflow state. The small display categories are `ACTION_REQUIRED`, `BLOCKED`, `WARNING`, and `OUTCOME`, with the concrete typed event retained underneath.

Inbox-worthy transitions include approval or other human action requests, agent escalation, Outline conflicts, prolonged runner or source unavailability, profile and repository-access failures, Repository Collisions, Retained Local Work requiring attention, Agent Run terminal outcomes, and pull-request states that require a human decision. Raw agent output, attempt starts, heartbeats, source refreshes, webhook receipts, ordinary progress messages, and Managed Loop ticks never create inbox items.

Items deduplicate by recipient, type, and durable subject. A repeated condition updates its existing item and may mark it unread again only after a material state transition instead of producing a stream of copies. Read state is personal; resolution follows the underlying condition and is not faked merely because someone opened the notification. Historical resolved items remain available for bounded audit and troubleshooting.

Live web toasts and badges mirror newly created or materially changed inbox items while a member is online; they are not a second source of notification history. Notification payloads contain a safe summary and reference rather than raw prompts, logs, credentials, document contents, or local filesystem details.

### Command Center Dashboard V1

The web home is a shared operational board for team situational awareness, complementary to the personal Notification Inbox. Its default derived lanes are **Needs attention**, **Active now**, **Waiting and scheduled**, and **Recently finished**. Project filters and compact runner, pull-request, and source-health summaries let a small team understand the system without opening every issue or run.

Alongside that operational board, v1 provides a GitHub planning surface for each connected GitHub Project. It projects eligible issue and pull-request items, filters and groups them by supported GitHub-owned fields such as Status, Iteration, and Milestone, and confirms field or membership mutations with GitHub. The planning surface and Command Center may cross-link the same issue, but neither copies the other's lifecycle or treats a GitHub Status column as Agent Run state.

Board cards are live projections of existing Coordination Records, Workflow Executions, Agent Runs, current Execution Attempts, and linked source state; they are not stored as another task entity. A Workflow Execution appears as a compact parent timeline with its constituent Agent Runs nested by step and iteration. Cards move automatically when authoritative source, workflow, or run events change. The board may look Kanban-like, but lanes are not draggable workflow states and Collab does not invent `TODO`, `IN_PROGRESS`, or `DONE` values beside GitHub's issue state and the Agent Run lifecycle.

Actions are explicit and semantic: **Delegate**, **Approve**, **Respond**, **Retry attempt**, **Cancel run**, **Start follow-up**, **Open in GitHub**, **Open document**, or **Open locally**, depending on the card and current authority. Each action displays the resulting source mutation or Agent Run transition instead of treating a drag gesture as an ambiguous command.

The Inbox answers "what needs me?" and retains personal read state. The Command Center answers "what is happening across the team?" and is identical for members except for actions involving personal or Shared Runners. GitHub issue, Milestone, and connected-Project views sit alongside the operational board as authoritative-source projections rather than a second Collab backlog.

### Agent Run Command Surface V1

The Agent Run is the sole durable command-and-status object for one execution goal. Creating one records its project, Run Goal, Repository Mode, Repository Assurance, selected runner, Execution Host, Interaction Mode and compatible Custom Launch Profile, `ONCE` or `MANAGED_LOOP` policy, attempt budget and deadline, attached context, grants, and initiating member before any process is requested. The new run begins as `QUEUED`; the shared server then creates and dispatches its first Execution Attempt through the selected runner's outbound data-plane connection. A Workflow Execution may orchestrate several distinct Agent Runs, but it never owns a process, terminal, worktree, or runtime lifecycle of its own.

The runner acknowledgement, preparation, process start, heartbeat, meaningful progress, source refreshes, checkpoints, branch and Published Git Reference, pull-request link, evidence, and terminal outcome all update the same Agent Run card. Its current and historical Execution Attempts appear as nested technical detail with their own immutable lifecycles. V1 has no separate runner job, terminal session, or execution-task entity for the UI to reconcile.

Contextual actions target the same aggregate: cancel the active attempt and run, respond to a checkpoint, retry the same goal through a new attempt in the existing worktree, open the worktree locally, or start a follow-up Agent Run for a different goal. The web, CLI, and MCP surfaces invoke the same semantic commands and observe the same event stream rather than implementing parallel launch workflows.

### Personal Run Presets V1

Users may create named Run Presets for recurring single-run patterns such as **Implementation headless**, **Interactive architecture**, **Review only**, or **PR babysit**. A Run Preset is server-stored user configuration for exactly one Agent Run, distinct from a runner-local Custom Launch Profile and from a multi-run Personal Workflow Preset. The Run Preset answers how this member usually wants one run assembled; the profile answers how one trusted machine invokes a particular agent CLI.

A preset may contain project scope, runner choice or personal default, Execution Host, Interaction Mode, opaque Custom Launch Profile reference and expected version, Repository Mode, required Repository Assurance, `ONCE` or `MANAGED_LOOP` policy, attempt budget, deadline and Stop Policy, context-assembly choices, required quality gates, and a reusable goal or instruction template. When derived from a Team Run Template, it stores the exact template version and may add a separately labelled personal instruction addendum, but it cannot replace or edit the template's core instructions. It never contains executable paths, environment values, local credentials, or server-supplied CLI arguments, and it cannot widen the selected profile, Shared Runner, project, or Document Write Grant.

The web can apply a preset from the New Run action and offers **Save as preset** after reviewing a launch. The CLI accepts `collab run --preset <name> <goal>`, and MCP exposes the same opaque preset identifier plus visible overrides. Applying a preset fills the launch form rather than hiding it: every effective field remains reviewable and may be overridden within the caller's authority before creation.

Every Agent Run snapshots the effective values used at creation, including the preset and profile versions, so later edits never mutate queued, running, or historical work. If a referenced runner, host, profile, sharing acknowledgement, or profile version is no longer eligible, the preset is shown as stale and requires an explicit compatible replacement rather than silently routing elsewhere.

V1 therefore uses transparent defaults and user-made presets instead of automatic agent or model routing. It may preselect the member's chosen default preset for a project, but it never chooses a cheaper model, different machine, different host, or wider permission profile behind the user's back.

### Team Run Templates V1

Any team member may publish a portable Team Run Template for a single-run pattern the team wants to repeat consistently. A template is versioned, team-visible intent and policy rather than a remotely executable profile. It may define a name and description, project scope, reusable core goal and instruction body with typed input variables, a typed result contract, context-assembly rules, Repository Mode and minimum Repository Assurance, required or allowed runtime traits, Execution Hosts and Interaction Modes, `ONCE` or `MANAGED_LOOP` policy, attempt budget, deadline and Stop Policy, quality gates, and document-access requests. Its core instructions and result contract are immutable within that version.

A Team Run Template never contains a private runner identifier, private profile reference, executable path, argument array, environment value, credential, runner-local hidden instruction fragment, or Document Write Grant. It may reference an exact runner and profile only when that combination is already exposed as a Shared Runner resource for the template's entire project scope; the UI labels this as a non-portable **Pinned team execution** rather than pretending it will work elsewhere.

Publishing from a Personal Run Preset shows a sanitization preview. Private runner and profile bindings are removed or converted into visible generic requirements such as `CLAUDE`, `ORCA`, and `INTERACTIVE`; instructions that will become team-visible are shown in full; unsupported local-only fields block publication until removed. The author confirms the resulting portable template before its first version becomes available.

Members may fork a template or publish a new version. Changing its core instructions requires a new version; a member who wants a different shared core may fork it, while a purely personal variation belongs in the derived preset's visible personal addendum. Editing never mutates existing Agent Runs or another member's Personal Run Preset. A newer template version is shown as available to derived presets, but adopting it is explicit because shared instructions, bounds, gates, or permission requests may have changed. Archiving prevents new use while preserving run provenance and prior versions.

### Automated Run Workflows V1

V1 includes automatic multi-run workflows as a first-class orchestration feature. A **Workflow Execution** coordinates a versioned sequence of distinct Agent Runs under one Coordination Record, such as **Implementation → Review → conditional Fix → Review**. Every step invocation creates a new Agent Run with its own Run Goal, lifecycle, Execution Attempts, worktree, authority, evidence, and terminal result. A workflow never turns a review or fix goal into another attempt of the implementation run.

The orchestration module has a deliberately small interface: launch a resolved Personal Workflow Preset with typed inputs; inspect its Workflow Execution; pause or resume future step scheduling; and cancel the workflow plus its active Agent Runs. Its implementation hides template and binding resolution, transition evaluation, idempotent Agent Run creation, bounds, durable launch intents, duplicate and out-of-order event handling, crash recovery, and audit projection. Workflow authoring is a separate module, preventing ordinary launch callers from learning a general-purpose graph language.

The workflow advances only from an authoritative terminal Agent Run plus a result that validates against that step's versioned typed result contract. Result keys may include domain-specific values such as `READY_FOR_REVIEW`, `APPROVED`, `CHANGES_REQUESTED`, `FIXED`, and `ESCALATE`. The coordinator never parses prompts, logs, terminal text, comments, or prose evidence to choose a transition. A zero process exit code is insufficient, and duplicate terminal events cannot launch the next step twice.

The transition definition may select another step, complete or fail the Workflow Execution, or move it to `WAITING` for a typed human decision. No agent process remains parked between steps or while waiting. Every workflow must snapshot a positive maximum total Agent Run count, a positive maximum traversal count for every cycle such as Review/Fix, and an absolute deadline. Bounds are checked before each launch, so a custom chain cannot become an unbounded autonomous pipeline.

A transition may also select a bounded **Parallel Step Group** containing only `INSPECT_ONLY` Agent Run steps. This supports patterns such as Claude and Codex independently reviewing the same Published Git Reference with different models and instructions. Every branch remains a distinct Agent Run with its own runner, profile, lifecycle, result contract, evidence, Context Recipe, and visible Repository Assurance; the group shares only the Workflow Execution, Coordination Record, immutable input artifact references, and join policy. An `ADVISORY` binding coordinates separate worktrees and withholds Collab write authority but does not claim hard host isolation. A template that requires `ENFORCED` inspection rejects advisory bindings during publication or launch.

V1 supports exactly two typed join policies. `ALL` waits until every branch is terminal and exposes the keyed result and artifact map to the next step. `ANY` commits the first branch result matching the join's declared accepted result keys and ignores later results for transition purposes. A failed or cancelled branch contributes the canonical `RUN_FAILED` or `RUN_CANCELLED` system result; a missing or invalid required result produces an explicit contract-violation reason rather than an indefinite wait. If every `ANY` branch becomes terminal without an accepted match, the join follows its required typed fallback transition. Branch logs or prose are never merged implicitly; a workflow that needs a combined judgment launches an explicit subsequent synthesis or review Agent Run over the branch result artifacts.

Every `ANY` join must also declare a remainder policy. `CANCEL_REMAINDER` atomically invalidates branch launch intents that have not created an Agent Run and submits ordinary cancellation requests to already-created losing Agent Runs. Those runs retain their own cancellation lifecycle and evidence, cancellation is best-effort rather than retroactive, and any result racing after the join remains non-transitioning evidence. `LET_FINISH` permits already queued or active branches to finish and records their late results while guaranteeing that they cannot transition the Workflow Execution again.

The authoring and final-launch views show the remainder policy beside the join and each affected branch. Built-in headless race templates use `CANCEL_REMAINDER`; templates containing an interactive branch use `LET_FINISH` unless their author deliberately chooses and visibly publishes cancellation behavior. The runtime never infers or changes the policy merely because a selected Personal Run Preset later binds a different Interaction Mode; an incompatible binding makes the workflow preset stale.

Every Parallel Step Group defines a positive maximum branch count, and the Workflow Execution retains its overall maximum Agent Run count, cycle bounds, deadline, and an effective maximum-concurrency ceiling no wider than the selected runners allow. Branch launch intents are durable and idempotent; unavailable runner capacity leaves a branch queued without parking another process. Completion events racing at an `ANY` join are serialized so the group can transition at most once.

Parallel `MUTATING` steps under one Coordination Record are rejected during template publication and launch preflight. A Team Workflow Template cannot encode an automatic Mutation Guard override. Independent Coordination Records may still run mutating work concurrently in separate worktrees under the existing Repository Collision rules, and a member retains the separate explicit audited override path for exceptional manual coordination.

Launching a Workflow Execution authorizes only the visible, resolved step configurations and workflow bounds shown in its final review. Each created Agent Run receives only the authority defined by its own Run Preset and still passes runner-dispatch, project, mutation-guard, document-grant, profile, and compatibility checks. A workflow cannot widen a later step because an earlier step had broader permissions. An unavailable runner, stale profile, missing typed result, failed gate, conflict, or requested human decision produces an explicit waiting or terminal reason rather than silent rerouting.

### Team Workflow Templates and Personal Workflow Presets V1

A **Team Workflow Template** is a portable, versioned orchestration definition. It contains named steps, references to versioned Team Run Templates, typed workflow inputs and step-result mappings, transition rules, human-decision points, cycle bounds, total-run bounds, deadline ceilings, and completion conditions. It never contains private runner identifiers, Personal Run Preset identifiers, local Custom Launch Profile references, executable arguments, environment values, or credentials.

A **Personal Workflow Preset** binds every agent step in a Team Workflow Template version to a compatible Personal Run Preset version. Because each referenced Run Preset may select its own runner, runtime adapter, Custom Launch Profile, Execution Host, Interaction Mode, and policy, one workflow can use Claude with one model for implementation, Codex with another model for review, and Pi or OpenCode for fixing. The exact executable, model argument, permission flags, credentials, and prompt transport remain runner-local inside each selected Custom Launch Profile.

A member may also create an entirely personal Workflow Preset without publishing a Team Workflow Template, but its steps still compose Personal Run Presets rather than embedding command configuration. Publishing it as a Team Workflow Template shows the same sanitization preview used for Team Run Templates and replaces personal bindings with portable Team Run Template references and generic compatibility requirements.

Every Workflow Execution snapshots its Team Workflow Template version when present, Personal Workflow Preset version, resolved inputs, step-to-Run-Preset bindings, profile versions and fingerprints, transition rules, authority summary, and bounds. Later edits never mutate active or historical orchestration. Launch preflight validates every known step binding; a material compatibility change before a later step begins is surfaced instead of substituting another CLI, model, runner, host, or mode.

### Visual Workflow Authoring V1

The primary Team Workflow Template authoring experience is an n8n-style node canvas built with the MIT-licensed React Flow `@xyflow/react` package. React Flow owns viewport interaction, selection, dragging, handles, edges, grouping, keyboard canvas behavior, minimap, and presentation layout. It is not the workflow engine or persistence contract: Collab's typed Workflow Definition remains the sole executable truth used by the server, CLI, MCP, validation, import/export, and future clients.

The canvas is schema-backed. A semantic Workflow Definition contains stable step keys and types, exact Team Run Template version references, typed input and result contracts, transitions, Parallel Step Groups, joins, remainder policies, cycle and run bounds, human decisions, and terminal outcomes. Separate Canvas Layout metadata contains node positions, viewport, collapsed groups, and other non-executable presentation state. React Flow node and edge objects are derived UI state and are never executed or accepted by the server as an authoritative definition.

V1 exposes a closed node palette:

- **Start** — the single workflow entry and typed workflow inputs.
- **Agent Run** — one Team Run Template step with typed result handles and generic execution requirements.
- **Human Decision** — named, typed choices that durably wait without parking an agent process.
- **Result Router** — explicit mapping from typed step or system results to later paths.
- **Parallel Split** — the start of one bounded `INSPECT_ONLY` Parallel Step Group.
- **Join** — an `ALL` or `ANY` join including fallback and, for `ANY`, remainder policy.
- **Terminal** — an explicit `COMPLETED`, `FAILED`, or `CANCELLED` Workflow Execution outcome.

V1 has no arbitrary code, shell, HTTP request, connector mutation, expression, script, or plugin node. GitHub, Outline, runner, and agent behavior remains behind the existing typed Run Templates and source commands. Adding a generic execution node would bypass the authority and adapter model and turn the editor into a second automation platform.

The authoring screen has a searchable node palette on the left, React Flow canvas in the center, selected-node inspector on the right, template/version and **Validate** and **Publish version** controls above, and a persistent problems drawer below. Nodes show concise semantic summaries rather than full configuration: step name, referenced Run Template, Repository Mode, typed results, required gates, generic runtime traits, and validation status. The inspector edits the typed definition; dragging only edits Canvas Layout metadata.

Connections use typed handles and reject obviously incompatible edges immediately. The client continuously compiles its draft into the Collab schema for fast feedback, while the server revalidates authoritatively before publishing. Validation includes unreachable steps; missing terminal paths, fallbacks, or typed results; incompatible handles; unbounded cycles; invalid parallel groups or joins; parallel `MUTATING` steps; missing `ANY` remainder policy; missing positive bounds; stale Run Template versions; and forbidden personal runner or profile data.

The web autosaves an optimistic, revisioned shared draft and provides local undo and redo. A stale draft revision never overwrites another member's work silently; the editor offers reload or duplicate-as-new-draft rather than attempting a semantic graph merge in v1. Publishing creates an immutable Workflow Definition version after server validation. Presentation-only layout revisions remain separate from executable version identity, while a published definition retains a layout snapshot for faithful historical display.

YAML import and export remains an advanced secondary surface over the typed Collab schema. Export contains no Personal Run Preset, private runner, profile, command, environment, or credential data; optional layout metadata is explicitly non-executable. Import creates or updates a draft, runs the same validation, and never publishes automatically. CLI and MCP authoring operate on this schema rather than React Flow serialization.

Personal binding uses the same graph in a separate **Bind my execution** view. Each Agent Run node selects a compatible Personal Run Preset and shows its resolved runtime, declared model, runner, host, mode, gates, and risk summary; those choices are saved only in the member's Personal Workflow Preset. The Team Workflow Template canvas remains portable and cannot reveal another member's bindings.

The same canvas becomes a read-only Workflow Execution view after launch. Nodes and edges display queued, running, waiting, paused, completed, failed, cancelled, join, and stale-artifact status; selecting a node opens its Agent Run, evidence, gates, and attempts. Execution status is a projection over the immutable definition and never mutates the template or Canvas Layout.

Keyboard-operable nodes and edges, meaningful accessible labels, focus management into the inspector, and a synchronized structured workflow outline are required rather than relying on pointer gestures alone. The v1 implementation uses memoized custom nodes and narrow state selectors, collapses large groups when useful, and requires no React Flow Pro feature so the open-source self-hosted product remains complete.

The common launch path is one operation. In the web composer, choosing **Workflow** instead of **Single run** presents the resolved step sequence or bounded parallel group and a compact per-step summary such as **Implement · Claude Opus · Orca · Headless**, **Review · Codex high reasoning · Native · Headless**, and **Fix · Pi · Orca · Interactive**. Expanded details show each Run Preset, profile version, authority, gates, transition and join results, `ANY` remainder policy, runner capacity, and bounds. The CLI and MCP surfaces expose the same semantics:

```text
collab workflow list
collab workflow start --preset personal:implement-review-fix --input goal="Implement issue 42"
collab workflow show <workflow-execution-id>
collab workflow pause <workflow-execution-id>
collab workflow resume <workflow-execution-id>
collab workflow cancel <workflow-execution-id>
```

### Workflow Execution Lifecycle V1

A Workflow Execution has the fixed `ACTIVE`, `WAITING`, `PAUSED`, `COMPLETED`, `FAILED`, and `CANCELLED` states. `ACTIVE` means a step launch is durably queued, an owned Agent Run is non-terminal, or the coordinator is processing a committed result. `WAITING` means a typed human decision or resolvable compatibility problem is required and no agent process is kept alive. `PAUSED` prevents new step launches by explicit member choice while already-created Agent Runs continue under their own lifecycle. Their results are recorded, but a resulting next-step launch remains durably suspended until resume. The three terminal states are immutable.

Cancelling a Workflow Execution atomically invalidates every not-yet-created step launch, marks the workflow `CANCELLED`, and submits an ordinary best-effort cancellation request to each active constituent Agent Run. The confirmation surface names those runs, runners, and interaction modes before applying the command. Each run retains its own immutable cancellation evidence, and a late result cannot revive or advance the cancelled workflow.

Cancelling one constituent Agent Run does not implicitly cancel its Workflow Execution. The workflow consumes the canonical `RUN_CANCELLED` system result and follows the template's declared transition, fallback, or waiting behavior. This allows one failed reviewer branch to be replaced or tolerated without turning every local run control into a hidden global command.

Each step occurrence has a stable idempotency key and binds to at most one Agent Run. The coordinator persists the transition decision and next launch intent before dispatch, rechecks pause, cancellation, and bounds, and tolerates restart or duplicate delivery without creating another run. Resuming revalidates runner eligibility, profile versions, source authority, bounds, and deadline before releasing a suspended launch. Workflow completion or failure never rewrites the terminal state of its constituent Agent Runs, and an independently completed run cannot advance a cancelled Workflow Execution.

The Workflow Execution's absolute deadline advances continuously in every non-terminal state, including `ACTIVE`, `WAITING`, and `PAUSED`; a pause is not a clock stop. At expiry the coordinator atomically invalidates future step launches, records the workflow `FAILED` with `WORKFLOW_DEADLINE_EXCEEDED`, and submits bounded best-effort cancellation to every non-terminal child Agent Run. Each child keeps its own lifecycle: a confirmed stop becomes `CANCELLED` or `TIMED_OUT` according to its own deadline evidence, while an unreachable attempt may become `LOST`. Late child results remain evidence but cannot transition the expired workflow. Resuming or resolving a human decision never extends the immutable deadline; additional time requires an explicit follow-up Workflow Execution.

### Portable Planning Workflows V1

Planning is an optional Team Workflow Template pattern rather than a universal runtime-specific Agent Run mode. The portable **Planning** step is an `INSPECT_ONLY` Agent Run with a typed `PLAN_READY` or `ESCALATE` result contract and a required bounded **Plan Artifact**. The artifact contains the proposed approach, assumptions, risks, affected areas, and verification strategy as human-visible authored content or an authorized Outline reference; it is not inferred from terminal prose.

A Personal Workflow Preset may bind the Planning step to any compatible runtime, model, runner, Execution Host, Interaction Mode, and Custom Launch Profile independently from the later Implementation step. If a CLI offers a native planning flag or permission mode, the runner owner may encode that invocation behavior in the Planning step's Custom Launch Profile. A runtime without native planning support follows the Team Run Template's planning instructions. Collab depends only on the portable result and artifact, not on how the CLI produced them.

V1 ships two editable Team Workflow Templates. **Plan → Implement** passes a successful Plan Artifact directly into the Implementation step's Context Recipe for unattended work. **Plan → Approve → Implement** inserts a typed human gate; approval launches implementation, changes requested create another bounded Planning Run, escalation waits, and stop cancels future orchestration. Neither template is mandatory or silently selected for an ordinary run.

Every planning, approval, and implementation transition is durable. No planning process stays alive while a human reads the artifact, and the implementation step may use a different CLI or machine without inheriting process memory. Approving a plan approves its content and transition only; it cannot widen the already reviewed implementation Run Preset, permissions, gates, bounds, or runner authority.

A runtime may still plan internally during one interactive or headless Agent Run. Collab treats that as runtime-owned behavior unless the run emits the typed Plan Artifact and participates in a Workflow Execution. V1 therefore avoids a misleading cross-runtime `planMode` flag while preserving native CLI planning where it is useful.

### Diff Evidence and Review Policy V1

Every `MUTATING` Agent Run records bounded diff evidence before it can report its deliverable ready or become `COMPLETED`: base and head commit identifiers when available, dirty or clean status, Changed-Path Snapshot, bounded file and line statistics, Published Git Reference when available, and the verification evidence required by its effective Run Configuration. A run that fails or is cancelled before producing a diff records that absence honestly rather than fabricating evidence. Collab does not duplicate raw source diffs into SQLite merely to support review. Humans inspect a published diff in GitHub or open the retained worktree locally; Review Runs inspect the immutable published ref or another explicitly available repository artifact through their own runner.

Diff evidence is universal, but approval is policy-driven. A Team Run Template or Personal Run Preset may require a human diff gate before that Agent Run can complete. A Team Workflow Template may instead follow a completed implementation run with one or more automatic Review Runs and conditional Fix Runs. `NONE`, human review, and automatic agent review are visible choices in the effective configuration; Collab never silently inserts a reviewer, model, or approval requirement.

A human diff gate is a durable checkpoint. The originating agent process exits, the run moves to `WAITING`, and the reviewer records a typed `APPROVED`, `CHANGES_REQUESTED`, or `ESCALATE` decision with optional bounded notes. The decision is bound to an immutable Approval Subject containing the run, base and head commit SHAs, Published Git Reference when present, Diff Evidence revision and digest, required Gate Evaluation identifiers and revisions, effective Run Configuration digest, and decision action. Any head movement, dirty-state change, gate rerun, evidence replacement, configuration change, or source revision change makes it `APPROVAL_STALE` and requires a new decision. Approval authorizes only the named transition; it cannot widen runner, connector, repository, grant, bounds, or profile authority. Changes requested may create another Execution Attempt against the same Run Goal and worktree when the template defines review as part of that goal; a materially separate review or fix goal remains a distinct linked Agent Run.

Automatic agent review is always modeled as another Agent Run, normally inside a Workflow Execution. The implementation run may already be immutably `COMPLETED` after publishing its deliverable and required evidence, while the enclosing workflow remains `ACTIVE` until review and any bounded fix cycle finish. The Review Run's typed result contract drives workflow transitions; process exit codes, review prose, and log parsing never do.

Cross-run automatic review requires a repository artifact accessible to the selected review runner. A Published Git Reference is the normal v1 handoff. If the implementation exists only in an unavailable local worktree, Collab does not reconstruct or upload it: the Workflow Execution moves to `WAITING` with a concrete artifact-unavailable reason. No review policy keeps an agent process alive while waiting for a human, another runner, or a later workflow step.

### Repository-Defined Quality Gates V1

Collab does not hard-code what verification means for every technology stack. Each repository may version a `.collab/gates.toml` manifest on its default branch containing arbitrary project-specific **Project Gates** and named ordered **Project Gate Sets** such as `pr_ready` or `release_ready`. A gate name is semantic and repository-local: JavaScript, Python, Rust, Xcode, documentation, database, hardware, and mixed-stack repositories may define entirely different commands and sets without implementing a Collab plugin.

V1 supports two gate kinds. A `LOCAL_COMMAND` gate declares one executable-and-argument array, working directory relative to the repository root, positive timeout, and bounded output policy. It never invokes a shell, contains secret values, selects an arbitrary absolute working directory, or receives server-supplied arguments or environment values. A `GITHUB_CHECK` gate declares the check names and acceptable conclusions that must be observed on the exact Published Git Reference. Waiting for GitHub is durable coordinator state and never keeps an agent or gate process parked.

The manifest used for an Agent Run is read from its pinned, trusted base revision rather than its agent-modified worktree. Every runner owner approves the manifest fingerprint once for each repository mapping before executing any local gate. The runner retains the full local recipe and advertises only a safe summary of gate and set names, kinds, limits, availability, and fingerprint. A manifest change becomes eligible only after it reaches the configured base branch and the runner owner approves its new fingerprint; a run cannot weaken or redefine the gates used to judge itself.

`collab gates init` may inspect conventional repository metadata such as package scripts, Python project files, Cargo manifests, Makefiles, Xcode schemes, and CI configuration to suggest a starting manifest. Suggestions are never activated automatically. A developer reviews, edits, commits, and approves the manifest through the normal repository workflow. `collab gates validate`, `collab gates inspect`, and `collab gates approve` expose parsing, effective recipes, and fingerprints before any Agent Run depends on them.

A Team Run Template or Team Workflow Template requests Project Gate Set names rather than command strings. Personal presets may add gates but may not remove a required set or replace its recipe. Launch preflight fails visibly when a selected runner lacks a compatible approved manifest fingerprint. Different workflow steps may request different sets, and every created Agent Run snapshots the required set names and effective manifest fingerprint.

Each evaluation is a durable **Gate Evaluation** tied to one Agent Run, exact repository revision, gate key, manifest fingerprint, and evaluation kind. A local evaluation records dispatch, start, exit code, duration, timeout or cancellation, bounded sanitized output evidence, and whether it changed tracked worktree state. A required local gate passes only on its declared successful exit and becomes invalid if it mutates tracked content. A GitHub evaluation records the authoritative check-run identifiers, conclusions, and observed commit SHA. Any later head change makes earlier results stale and requires fresh evaluations before completion.

The Runner Data Plane may request only `ExecuteLocalGate` and `CancelGateEvaluation` with an Agent Run identifier, gate key, approved fingerprint, and exact revision; it never transmits the gate command itself. The runner resolves and revalidates the approved local manifest, runs the gate in the Agent Run Worktree with its minimal owner-approved gate environment, and rejects stale fingerprints or revisions before process start. Raw gate output follows the same live-only and bounded-evidence policy as headless agent output.

Gate results are stronger than agent self-report because Collab or the runner observes the actual command or GitHub check against a specific revision. They still prove only that the approved verification operation ran and produced its declared result; they do not prove test quality, prevent an implementation from weakening repository tests, or replace diff review. Required gates and review policy therefore remain separate visible controls.

### Run Configuration Layers

The launch experience presents four layers without merging their authority:

| Layer | Owner and storage | Contains | Never contains |
|---|---|---|---|
| Team Run Template | Team, shared server | Portable intent, variables, context rules, generic runtime/host/mode requirements, autonomy policy, gates | Private runner/profile bindings, commands, environment, credentials |
| Personal Run Preset | Member, shared server | Concrete personal defaults and eligible runner/profile references, optionally derived from a template version | Executable paths, environment values, credentials, widened profile authority |
| Custom Launch Profile | Runner owner, runner-local | Executable resolution, fixed argument arrays, mode-specific prompt delivery, local limits and risk policy | Server-controlled arguments, team instructions, remote credentials |
| Effective Run Configuration | Immutable Agent Run snapshot | Resolved visible selections, preset/template/profile versions, grants, bounds, gates and provenance | Runner-local secrets or raw command configuration |

The layers compose in that order. A Team Run Template supplies portable workflow policy; the member's Personal Run Preset may bind it to an eligible runner and profile; the runner resolves the referenced Custom Launch Profile locally; the server and runner record only the safe effective snapshot and fingerprints needed for audit. A later layer may narrow an earlier one but may never widen a source permission, Shared Runner scope, profile risk ceiling, Document Write Grant, or hard execution limit.

### Prompt Ownership and Assembly V1

All task and workflow instruction content belongs to a Team Run Template, Personal Run Preset, or the individual Agent Run. A Custom Launch Profile never contains a hidden fixed task prompt, workflow prompt, or instruction preamble. It controls only the runner-local invocation and the adapter's `STDIN`, `ARGUMENT`, or `TERMINAL_INPUT` transport for the already assembled effective instructions.

At launch, Collab resolves the selected Team Run Template's typed variables without modifying its versioned core instructions, then appends the separately labelled Personal Run Preset addendum when present, the required per-run Run Goal, and a bounded reference-first bootstrap envelope produced by the selected Context Recipe. A derived preset cannot silently replace, delete, or interpolate arbitrary text into the shared core beyond its declared typed variables. The resulting Agent Run snapshots the instruction-bearing template and preset versions, resolved variable values, personal addendum, per-run authored input, Context Recipe version, reference and revision provenance, safe assembly hashes, and configuration choices so a team member can determine what the agent was asked to do without access to the runner's private command configuration. It does not persist a flattened runtime prompt containing fetched source bodies.

If a member needs to change the shared core instructions, they must publish a new Team Run Template version, fork the template, or create an independent Personal Run Preset. This makes inheritance visible: the UI and CLI display **Team core**, **Personal addendum**, and **This run** as separate instruction layers before launch and in historical provenance.

The referenced Custom Launch Profile is then resolved locally and delivers that effective task input using its fixed executable and argument recipe. One profile may therefore serve many presets, while the same portable Team Run Template may be bound through different Personal Run Presets to compatible profiles on different runners. Local environment values and credentials remain outside the assembled prompt and are never copied into the shared instruction snapshot.

### Context Recipes and On-Demand Retrieval V1

V1 uses explicit, versioned **Context Recipes** rather than eagerly concatenating every README, issue body, document, commit, related task, and open pull request into the launch prompt. A recipe defines which reference categories appear in the bootstrap envelope, maximum item counts, an optional small total preview budget, freshness requirements, and which predecessor summaries or evidence are included. It can narrow context selection but cannot widen repository mappings, Context Read Scopes, GitHub App permissions, Document Write Grants, or the Run Capability.

The built-in **Lean** recipe includes the Run Goal; Coordination Record and predecessor references; source item identifiers, titles, state, and observed revisions; repository, base branch, worktree, and instruction-file paths; linked pull request and Published Git Reference; named Outline document references and observed revisions; required gates and review policy; and concise prior checkpoint summaries when relevant. Full repository files, issue and pull-request bodies, review threads, Outline bodies, diffs, logs, and broad recent-history lists are omitted by default. A member may deliberately attach a bounded preview or authored excerpt when the initial instruction truly depends on exact text.

The agent retrieves details when needed through the tools that already own the data. Repository content is read from its Agent Run Worktree; GitHub details may be fetched through local `gh` or the run-scoped MTAAP GitHub tools; Outline search and document reads use MTAAP tools under the project's Context Read Scope; and `collab context inspect|get|search` exposes the same authorized retrieval path to CLIs without MCP support. References in the bootstrap envelope tell the agent what is available without preloading the content.

Every on-demand connector read revalidates the Run Capability and current source scope, records the safe source identifier, observed revision, time, and result status as access provenance, and returns the current authorized content or a structured stale, unavailable, or forbidden result. Collab does not persist retrieved document or issue bodies merely because an agent read them. When an exact historical revision cannot be fetched, the response identifies the newer observed revision rather than pretending it reproduced the launch-time content.

A Context Recipe may be project-owned and reusable, embedded as a versioned requirement in a Team Run Template, or selected and narrowed by a Personal Run Preset. Each Workflow step chooses its own recipe, so a Review Run can receive the Published Git Reference and review context without inheriting every implementation detail. The web and CLI show the recipe, reference list, preview budget, and effective access scopes before launch; presets never hide an unexpectedly large context preload.

### Best-Effort Usage Telemetry V1

V1 treats usage as operational telemetry rather than billing-grade accounting. Collab always records wall-clock duration, lifecycle timestamps, runtime adapter, Custom Launch Profile identifier and version, declared model label when the owner exposes one, Execution Attempt count, Managed Loop iteration count, and Gate Evaluation duration. Declared profile metadata is configuration provenance rather than proof that a remote provider served a particular model.

An Execution Adapter may report token or provider-usage metrics only through its reviewed structured output protocol. Collab never scrapes terminal prose or guesses usage from prompt length. Reported input, output, cached-input, reasoning, or total units retain their runtime-provided category and model identifier instead of being forced into a false cross-provider equivalence. Interactive sessions and runtimes without trustworthy structured metrics record `UNKNOWN`, never zero.

Agent Run and Workflow Execution views aggregate only compatible known metrics and always expose coverage, for example **known token usage for 4 of 6 attempts; 2 unknown**. A partial total is labelled partial, internal Runtime-Owned Loop ticks remain aggregated when the CLI exposes no per-tick data, and gate time is displayed separately from agent-runtime time. Later revisions or profile edits never rewrite historical telemetry.

V1 contains no provider pricing table, currency-cost estimate, spend budget, quota, chargeback, invoice, or billing enforcement. Usage cannot block a run or choose a cheaper model automatically. A future cost feature would require explicit provider-specific pricing versions and completeness guarantees rather than multiplying best-effort tokens by a mutable price remembered by the server.

### New Run Composer V1

V1 uses one progressively disclosed launch composer rather than a mandatory multi-page wizard. Its top row always shows the launch origin, project, source or context chips, and **Single run** or **Workflow**. A single run then offers **Blank**, **Personal preset**, or **Team template**; a workflow offers a Personal Workflow Preset or a Team Workflow Template requiring personal bindings. Launching from GitHub, Outline, search, a prior run, or the Command Center pre-attaches that origin without requiring an external work item. The composer never forces step transitions: unresolved or invalid sections expand in place, while a complete Personal Run Preset or Personal Workflow Preset reduces the common path to confirming typed inputs, reviewing the effective summary, and launching.

The composer groups fields into four visible sections:

1. **Intent and context** — required Run Goal, optional reusable-template variables, Coordination Record choice, selected Context Recipe and preview budget, attached GitHub or Outline references, repository instruction paths and requested document access.
2. **Execution** — selected runner, runtime and Custom Launch Profile, Execution Host, Interaction Mode, compatibility, online state, dispatch audience and applicable project/profile exposure, exact profile and policy versions, acknowledgement state, and a concise local risk summary.
3. **Autonomy and authority** — Repository Mode, `ADVISORY` or `ENFORCED` Repository Assurance, `ONCE` or `MANAGED_LOOP`, attempt budget, deadline, cadence and Stop Policy, quality gates, mutation conflicts and any Document Write Grant.
4. **Review and launch** — one effective configuration summary, changed-from-preset indicators, warnings, versions and fingerprints, followed by **Launch run**, **Save personal preset**, or **Publish team template** when eligible.

A fully resolved Personal Run Preset collapses the execution and autonomy sections into a readable summary, leaving the user to supply or confirm the goal and launch. A Team Run Template first applies any compatible personal preset derived from that template version. If no binding exists, the composer asks for the missing runner and profile once and offers **Remember my binding**, which creates a Personal Run Preset rather than mutating the team template.

Eligibility filtering is explanatory rather than magical. Profiles unsupported by the chosen Interaction Mode, runners without the project mapping or requested host, owner-only runners owned by another member, missing Team Dispatch Exposures, stale profile versions, revoked sharing acknowledgements, and policy conflicts remain visible with a short reason. Private profiles are not enumerated to non-owners. Collab never silently substitutes another model, runner, host, mode, or risk profile to make the form pass.

The final review always names the project and uses human-readable values such as **Collab · Tim's MacBook · Owner-authorized · Orca · Interactive · Claude Sonnet · Mutating / Advisory · Managed loop · 20 attempts / 24 hours**, with expandable exact profile, mapping, exposure, policy, approval, connector-epoch, and gate provenance. Creating the run snapshots these exact choices. The resulting Agent Run card links back to the Personal Run Preset and Team Run Template versions used, but later edits affect only future launches.

### Preset and Template CLI/MCP Flow V1

The CLI mirrors the composer rather than inventing a shortcut with different semantics:

```text
collab preset list
collab template list
collab run --preset personal:pr-babysit "Watch this branch's PR"
collab run --template team:review --context outline:<document-id>
collab preset create --from-run <run-id>
collab template publish --from-preset <preset-id>
```

An interactive terminal prompts only for unresolved template variables or runner/profile bindings and then prints the effective configuration before launch. A non-interactive invocation never guesses; it returns a structured `PRESET_BINDING_REQUIRED`, `TEMPLATE_INPUT_REQUIRED`, or stale-reference error listing the missing safe fields. Explicit CLI overrides are shown in the run snapshot and cannot inject runner-local arguments.

MCP exposes list and inspect operations for Personal Run Presets and Team Run Templates plus the same typed create-run operation accepting an identifier, expected version, goal inputs and safe overrides. It returns structured compatibility requirements rather than local profile details. Agents may suggest or create a personal preset only with the member's authority and may not publish a Team Run Template or widen permissions without an explicit human action.

### Preset Example: PR Babysit

A Team Run Template named **PR babysit** may define the branch-relative PR goal, refreshed GitHub context, `MANAGED_LOOP`, a three-clean-round Stop Policy, maximum attempts, absolute deadline and required verification evidence. It may permit Native or Orca and Headless or Interactive without naming a machine.

Tim's Personal Run Preset derived from it may contain the full babysitting instructions and bind **Tim's MacBook**, **Orca**, **Interactive**, and the opaque **Claude Sonnet bypass** profile. That runner-local Custom Launch Profile privately resolves the `claude` executable, model and permission arguments, terminal prompt-delivery strategy and local ceilings; it does not contain the babysitting workflow. The created Agent Run records the effective instructions, template, preset and profile versions plus the generic execution choices, while the shared server never receives the command or credentials.

### Source-Agnostic Agent Run Creation V1

An Agent Run requires a project and explicit Run Goal; a GitHub issue, pull request, or any other Work Source item is optional. The web exposes a global **New run** action and contextual **Delegate** actions from projects, GitHub issues, pull requests, Outline documents, search results, and prior runs. The CLI supports the same operation from a discovered project with a command such as `collab run <goal>`, while MCP exposes the equivalent typed operation.

Starting from a source attaches its stable reference and current revision as provenance and context; it does not change the Agent Run lifecycle. Starting from an Outline document may attach that document and request a Document Write Grant without creating a GitHub issue. Starting from a project or CLI may use only repository context and an authored goal. Collab never creates an external work item merely to justify execution.

A source-free mutating run still selects the project's mapped repository, receives its own Agent Run Worktree and branch, passes runner access preflight, and participates in repository collision detection. It has no GitHub closing reference unless a GitHub issue is deliberately linked, and completion changes no external work state. Source-backed and source-free runs share the same launch form, security policy, lifecycle, dashboard card, evidence model, notifications, and follow-up semantics.

### Universal Coordination Record V1

Every Agent Run belongs to exactly one Coordination Record. Starting from an already coordinated GitHub issue or prior run reuses its record; starting without one creates a minimal source-independent record automatically in the same transaction as the Agent Run. The member never has to create a placeholder issue, task, or record manually before launching execution.

The minimal record contains its project, concise title, creator, creation time, optional source and context references, Agent Runs and predecessor links, pull-request and Published Git References, coordination evidence, and mutation-guard state. It is a durable thread for related execution, not a Collab-owned backlog item: it has no `TODO` state, priority, assignee, estimate, sprint, due date, or completion lifecycle.

Follow-up review, fix, documentation, or retry goals may reuse the same record while remaining separate immutable Agent Runs. This gives source-backed and source-free work one history, collision scope, provenance model, and Command Center projection. An external source may be linked deliberately without rewriting the record's earlier origin or retroactively changing completed run semantics.

For every connector-owned actionable source item, the shared server enforces one canonical mapping key `(project_id, connector_id, source_item_id) -> coordination_record_id`. Creating from a source, webhook reconciliation, and late linking all use the same transaction and unique constraint. If two source-free records are concurrently linked to the same item, Collab does not leave two mutation guards: it either rejects the later link with the canonical record identified, or an authorized member explicitly coalesces the records by moving non-terminal run references, proposals, evidence, and guard reservations into the canonical record through one audited transaction. Completed run provenance remains immutable and gains an alias to the canonical record rather than being rewritten. Automatic content merging or last-write-wins record selection is prohibited.

### Execution Host and Interaction Axes V1

V1 models agent runtime, Execution Host, and Interaction Mode as three independent dimensions. The runtime Execution Adapter selects Claude, Codex, Pi, OpenCode, or another bundled agent integration. The Execution Host selects `NATIVE` or `ORCA`. The Interaction Mode selects `HEADLESS` or `INTERACTIVE`; the UI may describe the latter as headed or interactive execution. Runner Dispatch Audience is a separate authorization concern and never changes merely because a run is interactive or headless.

All four host and interaction combinations are first-class: `NATIVE + HEADLESS` launches a supervised batch process directly; `NATIVE + INTERACTIVE` launches an interactive local PTY or terminal; `ORCA + HEADLESS` launches a non-interactive agent command inside an Orca-managed workspace; and `ORCA + INTERACTIVE` launches or focuses an interactive Orca terminal. Neither host implies an interaction style, and callers never infer one from the other.

The selected runner advertises a generic compatibility matrix for its installed Execution Hosts and exposed profiles. A Custom Launch Profile declares which Interaction Modes its runtime recipe supports, while host compatibility is validated separately. The web, CLI, and MCP select the desired host, mode, and a compatible profile without sending runtime flags, commands, terminal input, or local paths. Unsupported combinations fail before process start with stable `EXECUTION_HOST_UNAVAILABLE` or `INTERACTION_MODE_UNSUPPORTED` results.

Each Execution Attempt snapshots its Execution Host, Interaction Mode, profile version, and effective limits. A later attempt in the same Agent Run and worktree may deliberately choose another compatible host or mode for a checkpoint, human handoff, or autonomous continuation without rewriting earlier attempt history. Process supervision, cancellation, deadlines, evidence, and Agent Run semantics remain identical across all combinations.

The runner contains a real internal Execution Host seam because both Native and Orca adapters exist. The runtime Execution Adapter prepares a host-neutral invocation and output protocol; the selected host adapter starts, cancels, reconciles, and, for `INTERACTIVE`, provides local attachment. This separation keeps runtime-specific flags and parsing local to the Execution Adapter while terminal and workspace hosting remain local to the host adapter.

### Local Interactive Security Boundary V1

`INTERACTIVE` guarantees that any human interaction occurs only on the selected runner's trusted machine through its Native terminal or Orca workspace. Terminal keystrokes, PTY byte streams, interactive prompts and responses, local attachment handles, control sequences, and terminal history never transit through the shared server, browser transport, MCP, Durable Outbox, or coordination database. Encrypting the runner channel does not relax this rule.

The web remains a status and semantic-control surface. It may create the run, show lifecycle and local presence, receive sanitized structured observations and evidence, cancel the attempt, respond to a durable checkpoint after its process exits, and provide an **Open locally** instruction. It cannot type into the agent, forward clipboard content, request arbitrary signals, or expose a browser terminal. Server-originated controls remain a closed typed set rather than a general terminal-input message.

Native interaction attaches through a runner-owned local PTY or terminal; Orca interaction attaches through an Orca-owned local terminal. `ATTACHED` and `DETACHED` are live local-presence values beneath the current Execution Attempt, not Interaction Modes, Agent Run lifecycles, or second execution entities. Full interactive terminal transcripts remain local by default even when comparable headless stdout would qualify for bounded live streaming.

If an interactive process needs a human who is no longer present, the runner's local presence policy and absolute deadline determine when to request a checkpoint, terminate, or report that the run requires a later attempt. Collab never keeps an interactive process alive indefinitely merely because no remote user can reach its terminal.

### Execution Authority and Runner Exposure V1

Every Registered Runner has one immutable owner and one versioned Runner Dispatch Audience: `OWNER_ONLY` or `TEAM`. The default is `OWNER_ONLY`. Only that runner's owner may dispatch work to an owner-only runner through the web, CLI, MCP, workflow scheduler, or local CLI. If the runner and selected profile are compatible, the owner's dispatch may be Native or Orca and Headless or Interactive without a second approval. A Collab team Owner cannot override another runner owner's policy merely because both are product owners.

`TEAM` does not expose the runner wholesale. Its owner creates explicit Team Dispatch Exposures for exact project mapping and Custom Launch Profile version pairs. Any current Collab team member may dispatch only within that exposed intersection; all other mappings and profiles remain private and are not enumerated to non-owners. V1 has no per-member runner allowlist: dispatch is either owner-only or available to the whole Collab team for the named exposure. Changing audience or exposure is an explicit, audited owner action and never follows automatically from team, GitHub, or project membership changes.

The shared server contains one deep `ExecutionAuthority` module at the intent-to-attempt boundary. Web, CLI, MCP, workflow scheduling, and runner transport may preview an attempt and submit a closed typed authority command; they do not reproduce membership, original-dispatcher, runner ownership, exposure, connector, approval, mutation-lease, revision, retry, or revocation rules. The module atomically owns new-run launch, later-attempt authorization, single-use permit creation and consumption, live authority renewal, operation authorization, release, and runner-policy replacement. Expected policy rejection returns stable `WAITING` or `DENIED` values with safe explanations; transport failure and storage corruption remain distinct internal failures.

The ordinary path is still one launch operation. It validates idempotency; active membership; the exact project and Coordination Record revision; the runner heartbeat, epoch, owner or Team Dispatch Exposure, mapping and profile versions, acknowledgement and host/mode compatibility; repository base revision and Repository Assurance; connector epochs and scopes; exact Approval Subjects; workflow and attempt bounds; and the Work Item Mutation Guard. In one SQLite transaction it creates the Agent Run when needed, Execution Attempt, immutable Authority Snapshot, single-use Dispatch Permit, mutation-lease reservation when mutating, audit event, and WSS dispatch outbox record. A runner consumes that permit immediately before process creation and rejects expiry, replay, revocation, epoch movement, stale policy, or lost mutation authority.

After permit consumption, the attempt holds a short-lived fenced Authority Session. A `MUTATING` attempt must renew its live mutation lease before expiry; after a bounded network grace period it must checkpoint and stop before further repository mutation, publish, or external connector write. Every publish, GitHub or Outline mutation, approval-gated transition, and destructive cleanup obtains operation-level authorization against the current session fence and exact resource revision immediately before the action. An `INSPECT_ONLY` session contains none of those Collab capabilities. Trusted `ADVISORY` runners are still capable of bypassing the cooperative client with their owner's ambient credentials, which is why the UI never describes this model as a sandbox.

Revocation has explicit dispositions. Member removal, cancellation, absolute-deadline expiry, runner-identity revocation, and repository-authority revocation request checkpoint and termination; future operations are denied immediately, while process termination remains `REQUESTED`, `CONFIRMED`, or eventually `LOST` based on runner evidence. Connector scope narrowing denies affected connector operations and moves required work to `WAITING` without destroying unrelated local progress. Revoking Team dispatch or one exposure invalidates unused permits and blocks future attempts; an owner chooses separately whether to stop attempts already running under a previously valid session. All actions are audited with dispatcher and runner owner as distinct actors.

The module keeps policy evaluation and SQLite transaction structure private. SQLite is an internal local-substitutable seam tested with isolated databases. Outbound WSS runner control is a remote-but-owned adapter with an in-memory test implementation. GitHub and Outline are true external ports with strict mock adapters. Trusted Native, trusted Orca, and future isolated execution are runner-side enforcement adapters behind the same authority vocabulary; adding an enforced sandbox must not require callers to learn a second launch system.

### Dispatch Authorization for Retries and Managed Loops V1

Every new Execution Attempt, including a retry, resume, workflow step, or Managed Loop iteration, receives a fresh authorization using the original dispatcher as principal. No earlier permit or successful attempt grants continuing access. If ownership, team membership, mapping, profile exposure, acknowledgement, runner epoch, or policy revision no longer qualifies, the scheduler creates no process and no Execution Attempt, moves the Agent Run to `WAITING` with a stable dispatch-authorization reason, and notifies the dispatcher and runner owner. Because no attempt was created, the pause does not consume a Managed Loop's maximum-attempt count.

Restoring eligibility does not silently resume a run deliberately stopped by a revocation; an authorized member explicitly resumes it, and the next attempt is authorized against current policy. Absolute deadlines continue while waiting. If policy changes race with an already-created attempt, the runner rejects preparation with a stable reason; that immutable `FAILED_TO_START` attempt remains evidence and counts normally under Loop Bounds.

`INTERACTIVE` remains valid for Managed Loops on both Native and Orca hosts. `DETACHED` local presence does not pause scheduling or terminate an iteration: the session remains locally visible and attachable, while its Stop Policy, attempt limit, and absolute deadline continue to govern automation. Presence is observational rather than a hidden approval gate.

Each interactive Agent Run should reuse one local session surface where the host supports it: an Orca workspace and terminal or a runner-owned Native terminal surface. Individual agent processes still start and exit per Execution Attempt; surface reuse must not keep an agent process parked between iterations. If safe reuse is unavailable, the host may create a new local surface subject to bounded concurrency and window-spam protection.

### Core Components

1. **`collab` CLI**
   - Local developer entry point and runner process.
   - Commands: `init`, `list`, `start`, `status`, `note`, `complete`, `review`, `projects`.
   - Connects to the shared server, prepares local worktrees, and spawns the user's preferred agent with task context.

2. **Local Runner Cache and Outbox**
   - Stores repo mappings, previously retrieved context, runner registration, and idempotent events produced during short network interruptions.
   - Never owns leases, grants, task lifecycle, or canonical run state.
   - Keeps local git credentials, worktrees, terminals, and agent processes outside the shared server.

3. **Shared Coordination Server**
   - Authoritative store for Collab Projects, members, Coordination Records, Workflow Executions, leases, Agent Runs, grants, proposals, evidence, and connector references.
   - Uses server-side SQLite on a persistent volume in v1, with backups and an upgrade path only if real scale demands it.
   - Holds GitHub App and Outline bot credentials, processes webhooks, reconciles selected repositories and GitHub Projects, validates transitions, and broadcasts events.

4. **Web Interface**
   - The always-on team home for creating and triaging work, operating selected GitHub Projects and Milestones, assembling context, visually authoring and binding schema-backed workflows, delegating runs and workflows, reviewing proposals, editing Outline-backed documents, and observing execution.
   - Reads and writes the same authoritative Coordination Records as the CLI and MCP server.
   - Routes execution requests to an eligible developer-controlled local runner rather than executing agent commands on the server.

5. **MCP Server**
   - A thin authenticated protocol adapter over the shared coordination server.
   - Exposes the same semantic operations used by the CLI and web interface without containing connector or UI implementations.

6. **Source and Execution Adapters**
   - Work and planning source: GitHub Issues, pull requests, Milestones, and selected existing organization-owned GitHub Projects through the server-side GitHub App.
   - Context source: Outline through live federated search and the server-side MTAAP Bot Identity.
   - Execution environments: Orca and a native local runner; runtime-specific agent integration stays behind the runner's Execution Adapter seam.

7. **Agent Integration**
   - First adapters: Claude and Codex, with the interface deliberately validated against Pi and OpenCode's current interactive, non-interactive, and structured-event modes.
   - Adding Pi, OpenCode, or a later runtime must not require changes to the shared server, web interface, MCP tools, Agent Run lifecycle, or runner security policy.
   - Adapter selection, runtime defaults, and Custom Launch Profiles are configured locally on the runner. Every supported adapter may expose multiple owner-defined profiles, but v1 has no server-supplied shell-command or argument escape hatch.
   - The same Agent Run can be started from the CLI, the web interface, or an MCP client.

### Custom Launch Profiles V1

Every supported Execution Adapter may have multiple runner-local Custom Launch Profiles. A profile selects its installed adapter, locally resolved executable reference, fixed arguments and prompt-delivery recipe for one or both Interaction Modes, generic execution traits, and execution limits. This supports a headless profile such as Claude print mode, an interactive profile, or mode-specific recipes with selected models and permission policies without adding runtime-specific switches to the server, web interface, or MCP tools.

Profiles are data passed to the runner's existing Execution Adapter implementation, not arbitrary shell programs. Arguments are stored and executed as an array; the runner never asks a shell to interpret the assembled command. Prompt text is kept separate and delivered through the adapter's declared `STDIN`, `ARGUMENT`, or local `TERMINAL_INPUT` strategy, so shell-looking text such as `$()`, quotes, redirects, and newlines remains literal agent input. `STDIN` is preferred for headless modes and large prompts; `ARGUMENT` is permitted only when the installed runtime requires an initial positional prompt and the runner enforces platform size limits; `TERMINAL_INPUT` is available only to an interactive local host adapter.

Only the Registered Runner's owner may create or edit a profile. The shared server knows its opaque profile identifier, display name, adapter, generic execution traits, risk summary, version, and configuration fingerprint, but never receives its executable path, full argument values, environment, or credentials. Profiles may not contain task or workflow instructions; those remain visible and auditable in the Personal Run Preset, Team Run Template, or individual Agent Run. An owner may expose selected profiles to selected project mappings on a Shared Runner; any material profile change creates a new version and requires that sharing acknowledgement to be renewed.

An invocation using a profile may be a long-running autonomous process, including a polling loop requested by its effective workflow instructions, provided the Execution Attempt still has an explicit deadline or budget, emits heartbeats, remains cancellable, and never stays alive merely to wait for human review. Permission-bypassing profiles are allowed only when locally configured and explicitly acknowledged by the runner owner; another project member cannot introduce or widen those flags through a dispatch request.

V1 profiles are limited to installed, supported Execution Adapters. Within that adapter, the runner owner may supply arbitrary fixed arguments such as model, permission, effort, or runtime behavior flags, subject to adapter validation, but may not embed task or workflow instruction content in those arguments. The adapter reserves any arguments required to preserve prompt placement, structured output decoding, worktree ownership, process supervision, and the runner's security invariants; conflicting or unsupported combinations fail locally before process start.

V1 has no generic arbitrary-executable adapter. Supporting a previously unknown CLI requires an Execution Adapter implementation, conformance fixtures, and explicit installation or enablement by the runner owner. This is intentional: it gives a new runtime a defined prompt strategy, output and error interpretation, capability declaration, and safe interaction with the Execution Attempt lifecycle instead of treating an opaque process as if MTAAP understood it.

### Prepared Execution Adapter Contract V1

The Execution Adapter seam uses prepared execution for every host and interaction combination. After the shared server dispatches an Execution Attempt with an opaque profile identifier, generic Execution Host, and Interaction Mode, the selected runner resolves that identifier to its local Custom Launch Profile and asks the installed adapter to prepare the invocation. The adapter returns an immutable Prepared Execution containing a host-neutral local invocation recipe, prompt-delivery plan, interaction contract, runtime output protocol, and bounded runtime requirements needed by the common runner supervisor. Preparation never starts a process and never invokes a shell.

The runner, not either adapter, owns the security and lifecycle boundary. It supplies the already-created Agent Run Worktree, constructs the permitted environment from runner-local configuration, selects the requested compatible Native or Orca host adapter, supervises the resulting local session, enforces deadlines and output bounds, emits heartbeats, handles cancellation and process-tree cleanup, and records Execution Attempt transitions. The runtime adapter may validate the selected profile and generic execution requirements, but it cannot select worktree ownership, mint credentials, publish server events directly, or override the runner's limits.

The runtime output protocol translates runtime-specific stdout, stderr, terminal observations, structured output, and exit information into canonical execution events and sanitized evidence. It does not decide whether the Agent Run goal succeeded: process exit and decoded messages remain evidence for the runner and coordination layer. Full interactive terminal input remains inside the local host. Unsupported profiles, conflicting reserved arguments, unavailable hosts, or unsupported interaction requests fail during preparation before process start and are recorded as a sanitized `FAILED_TO_START` attempt.

Claude, Codex, Pi, OpenCode, and later supported runtimes may differ in flags, prompt transport, interactive readiness, model selection, and output format while sharing one worktree, supervision, cancellation, security, and event pipeline. Native and Orca hosting vary behind the separate internal Execution Host seam, so adding or fixing a host does not spread runtime-specific logic across every Execution Adapter.

### Execution Adapter Distribution V1

V1 loads only Execution Adapters bundled with the installed runner release. It performs no runtime discovery or loading of owner-installed adapter packages, and neither the shared server nor a project can ask a runner to download or execute adapter code. Runner owners may enable or disable bundled adapters and configure their Custom Launch Profiles locally, but adapter implementation code changes only when they deliberately update the runner.

The adapter seam remains an internal, documented extension point with a shared conformance suite. An open-source contributor can add a runtime by implementing that contract and its fixtures in the project, after which the adapter ships through the normal reviewed runner release process. The runner reports only the identifiers, versions, generic execution traits, and profile summaries of adapters it already contains; server dispatch cannot widen that inventory.

Owner-installed, versioned adapter packages are deferred until demand justifies a separate trust and compatibility design covering authenticity, updates, API compatibility, isolation, revocation, and failure containment. Extensibility in v1 therefore means that adding a supported runtime is local to the runner and does not disturb the coordination architecture, not that arbitrary third-party code is dynamically loaded on trusted developer machines.

### Runtime-Agnostic Dispatch V1

V1 dispatch never contains runtime-specific capability requests. The coordination server selects an exposed profile and sends the Agent Run and Attempt identities, Run Goal, Repository Mode, generic Execution Host, Interaction Mode, assembled task input, bounded execution policy, and expected profile version. Its only adapter-level assumptions are the runner-advertised compatibility of that host, mode, and profile. Model choice, reasoning or effort level, permission mode, prompt transport, structured-output format, session behavior, and workflow flags remain entirely inside the runner-local profile and its adapter.

The server may use a runner's advertised profile availability and generic execution traits to avoid obviously impossible assignments, but the runner remains authoritative at preparation time. There is no vendor-specific option map, passthrough argument field, or capability escape hatch in the web, CLI, MCP, or dispatch protocol. A caller selects among the profiles the runner owner deliberately exposed; it cannot widen or modify one.

Preparation failures use stable, runtime-neutral codes such as `PROFILE_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `PROFILE_POLICY_DENIED`, and `PROFILE_VERSION_MISMATCH`. The shared record receives the code, a safe human-readable explanation, and a diagnostic correlation identifier; executable paths, arguments, environment values, raw adapter errors, and other local configuration details remain in runner-local logs. A failure discovered after an Execution Attempt is created transitions that attempt to `FAILED_TO_START` without pretending the Agent Run goal itself was attempted successfully.

### Project Discovery and Auth

The repo itself should be self-describing. A `.collab/config.toml` file lives in the project root and contains the project and team identifiers. The CLI discovers it by walking up the directory tree, so a developer can run `collab list` or `collab status` from anywhere in the repo.

```toml
# .collab/config.toml
project_id = "proj_abc123"
team_id = "team_xyz789"
server_url = "https://collab.example.com"
base_branch = "main"
```

The tracker file is separate from agent guidance files like `AGENTS.md` or `CLAUDE.md`. This keeps machine-readable config clean and avoids parsing ambiguity. Agent guidance can still live in those files and be loaded by the context assembler.

Authorization is **team-scoped**, while credentials remain per-user so grants, approvals, and human edits have a real actor. A local runner is paired with a signed-in user through a one-time code confirmed in the web interface. Its long-lived credential is stored in the OS credential store, never a project file; normal access uses short-lived, audience-restricted, DPoP sender-constrained tokens with rotating refresh credentials. Local agent processes receive short-lived Run Capabilities limited to one Agent Run and its allowed operations rather than a reusable user, team, or runner secret.

The repo file is not just for humans. It is also how the agent knows which project it is working on. When an agent is spawned inside a repo, the MCP server reads `.collab/config.toml` and uses the `project_id` to load the right project context and any explicitly linked Coordination Record. This is both repo-driven and agent-driven: the repo provides identity, the agent provides execution.

### Global Project Registry

The CLI should also work from outside a repo. A SQLite global registry at `~/.collab/global.db` remembers every project that has been invoked at least once. This lets a developer run commands like `collab projects` or `collab status --all` from anywhere on their machine.

From this global view, the user can:

- See all active Agent Runs across all known projects.
- Start an agent in a specific project without `cd`-ing into the repo.
- Start multiple agents in different projects in parallel.
- Use git worktrees so each active Agent Run has its own isolated working directory while its sequential Execution Attempts preserve local state.

The global registry maps `project_id` to the local repo path, so `collab start --project proj_abc123` works from any directory. Canonical project state remains on the shared server; the registry stores only local paths, runner metadata, cache pointers, and last access time.

The primary command for the global view should be `collab projects`. It lists all known projects with their current state and active Agent Runs. If the user is inside a repo, `collab` with no subcommand can show repo-level status; if outside a repo, it can show the global view. This makes `collab` feel like a command center, not just a per-repo utility.

Commands for the global view:

- `collab projects` — list all known projects, their current state, and active Agent Runs.
- `collab start --project <project_id>` — start an agent in the specified project.
- `collab status --all` — show all active Agent Runs across all projects.
- `collab flush` — retry queued idempotent runner events after a network interruption.

### Runner Registration and Web Launch

Each local runner registers a stable identity, immutable owner, execution adapters, project-to-repo mappings, Runner Dispatch Audience, policy revision, runner epoch, and heartbeat with the shared server. A runner is eligible for a launch only when it is recently online, has the selected project mapped locally, supports the requested execution environment, and authorizes the dispatcher for the exact project/profile exposure.

Runners are `OWNER_ONLY` by default. Their owner may change the audience to `TEAM` and expose exact project mapping and Custom Launch Profile version pairs, allowing any current Collab team member to choose only those combinations as a dispatch target. Sharing never exposes credentials, commands, private profiles, or filesystem paths through Collab and can be revoked only by the runner owner. Headless and Interactive choices use the same eligibility rule.

Enabling each Team Dispatch Exposure requires a versioned acknowledgement. It states that dispatched agent processes execute as the runner's operating-system user, may use that user's locally configured credentials, and are isolated by a dedicated worktree rather than a host sandbox. The acknowledgement names the project mapping, opaque profile version, adapters, runner, owner, security-policy version, and time accepted. Collab asks again whenever the exposure or material security policy changes; accepting a warning never broadens the configured mapping, profile, or adapter allowlists.

V1 runners are trusted-machine execution supervisors rather than a container platform. Their first Execution Adapters support Claude and Codex, with Pi and OpenCode validated against the same interface, while their Native and Orca Execution Host adapters support both headless and interactive sessions in dedicated Agent Run worktrees. Each Execution Attempt inherits the runner owner's locally configured agent, git, and `gh` credentials and reuses its run's worktree; those credentials never transit through MTAAP. The Agent Run distinguishes the member who dispatched the run from the owner of the machine and credentials that executed it.

The runner reports agent-attempt acknowledgement, process start, logs and progress, cancellation, exit status, gate-evaluation state, and verification evidence back to the shared server. If a headless agent process needs human input, it checkpoints and exits so a later interactive Execution Attempt can resume; MTAAP does not keep a headless CLI process parked indefinitely. Full container isolation, remote shell access, and arbitrary server-hosted execution are outside v1.

When a user launches an Agent Run from the web interface, Collab preselects that user's most recently active eligible runner and shows whether it is **Owner-authorized** or **Team-authorized** before dispatch. The user may explicitly override the selection with another eligible runner they are authorized to use. The selection remains changeable only until a runner creates the Agent Run Worktree; from that point the run is pinned to that runner. V1 never performs automatic load balancing or silently redirects execution to another machine.

The selected runner must acknowledge the launch before an Execution Attempt becomes active. If acknowledgement times out, the Agent Run remains visibly pending and the user may retry, retarget, or cancel it; the server does not infer that a local process started.

### Secure Runner Data Plane

The runner establishes an outbound-only WSS control and data channel to the shared server over TLS 1.3, with TLS 1.2 allowed only when required for compatibility. Certificate validation is mandatory and v1 has no insecure bypass. Browsers receive committed coordination updates through authenticated SSE; the bidirectional runner channel is separate because it carries dispatch, acknowledgement, cancellation, progress, and live output.

Runner messages use a small typed protocol rather than remotely supplied commands. Every frame is schema-validated and carries a server-assigned message identifier, runner and Agent Run identifiers, the applicable Execution Attempt or Gate Evaluation identifier, issue and expiry times, and replay protection. The channel enforces message-size limits, per-run and per-runner rate limits, heartbeats, idle timeouts, bounded reconnects, and backpressure. The runner rejects duplicate or stale messages, mismatched assignments, unsupported adapter options, unapproved gate fingerprints, unmapped projects, non-canonical paths, and revoked credentials.

The server may request only allowlisted operations such as `LaunchAttempt`, `CancelAttempt`, `ExecuteLocalGate`, and `CancelGateEvaluation`. It never supplies a shell command, arbitrary executable path, gate command, caller-controlled working directory, environment dump, or raw credentials. The runner constructs an argument array from a locally configured adapter or resolves a gate from an owner-approved manifest fingerprint, validates the project mapping, resolves the run's opaque local worktree identifier, and passes a minimal explicit environment.

Raw headless agent stdout, stderr, and local gate output are sensitive and live-only by default. The runner applies best-effort local redaction for common tokens, authorization headers, private keys, and passwords before transmission, then streams bounded sequence-numbered chunks only to authorized project members. Interactive terminal byte streams and transcripts remain local rather than using this path. The server may keep a bounded in-memory reconnect buffer during an active headless attempt or Gate Evaluation but does not write raw process output, flattened runtime prompts, fetched source bodies, or environment data to SQLite, backups, or the Durable Outbox. The web interface renders permitted output as escaped terminal text and rejects unsafe links and control sequences.

For owner diagnostics, the runner may retain an opt-in encrypted local tail capped by both bytes and age, disabled by default for interactive sessions and never synchronized to the server. Only the runner owner can reveal or export it through a local command after reauthentication; project members see only its presence, size, expiry, and a correlation identifier. Expiry securely removes the tail on a best-effort basis, and disabling collection prevents future capture rather than claiming forensic erasure from storage snapshots. Structured safe evidence remains the normal shared debugging surface.

Durable coordination stores versioned authored instruction components, explicitly bounded attached previews, structured lifecycle events, progress summaries, decisions, approved excerpts, exit status, verification evidence, hashes, and reference provenance. Pairing, dispatch, acknowledgement, cancellation, authentication failures, policy rejections, revocation, and access to sensitive live streams are audited without recording tokens, fetched source bodies, or the flattened runtime prompt.

### Non-Goals

- No multi-tenancy.
- No billing or seat management.
- No LDAP, enterprise SSO, or general identity-provider matrix. Minimal product login and connector-specific delegated authorization are required.
- No plugin marketplace or sandboxed runtime.
- No enterprise admin suite or general-purpose project-management replacement. The focused shared web interface is part of v1.

## What to Keep vs. What to Discard

### Keep

- MCP-first, agent-agnostic design.
- Explicit source, Agent Run, and pull-request lifecycles as separate semantic contracts.
- Branch-per-task and PR-per-completion workflow.
- Per-user and run-scoped token authentication for CLI and MCP access.
- Durable shared coordination state plus a bounded local runner cache and outbox.
- Project context (README, stack, conventions, recent completed tasks).
- The idea that a task can be launched from multiple surfaces: CLI, web interface, or another agent via MCP.
- Authenticated SSE for browser projections and an outbound WSS Runner Data Plane for bidirectional dispatch and ephemeral live output.

### Discard

- Multi-tenancy, organizations, and seat management.
- Billing, pricing tiers, and RevenueCat/Stripe.
- The old SaaS/admin webapp; rebuild only the focused shared team surface.
- The Tauri/Rust desktop companion (replace with CLI spawning).
- RFC-001's general plugin runtime and marketplace; keep only explicit first-party GitHub and Outline adapters in v1.
- Server-side git operations (move to local agent commands).
- General OAuth-provider and LDAP complexity beyond the connector and login flows v1 actually needs.
- The MCP server UI components.

### Defer or Constrain

- Audit retention and export depth: core provenance exists in v1, while enterprise retention policy is deferred.
- Email notifications: likely unnecessary when the shared inbox and in-product notifications are available.

## Coordination State and Offline Resilience

### Recommended Model: Shared Authority with Local Continuity

The **Shared Coordination Server is the source of truth** for MTAAP-owned state. Local runners remain operational during short network interruptions through a bounded read cache and durable event outbox, but they never merge competing task databases or resolve coordination conflicts with last-write-wins.

```
[work/context sources] <--> [shared coordination server] <--> [web / CLI / MCP]
                                   ^
                                   |
                         [local runner cache + outbox]
                                   |
                         [worktrees / agent processes]
```

### Core Mechanism

1. **Authoritative operations**: Claims, leases, grants, task transitions, approvals, and connector writes are validated and committed by the shared server.
2. **Read cache**: The local runner may retain recently fetched task context and run metadata so an already-started execution can continue through a brief outage.
3. **Durable outbox**: Structured progress, notes, and verification evidence receive idempotency keys and are queued locally if the server is unreachable. Raw prompts and process output are never placed in the outbox.
4. **Reconnect**: The runner submits queued events in order. The server deduplicates them and revalidates any requested state transition against current authoritative state.
5. **Live projection**: The server broadcasts committed events to browser and ordinary API clients through SSE. The runner uses the separately specified outbound WSS data plane because dispatch, acknowledgement, cancellation, and session control are already a real bidirectional transport requirement.

### Offline Safety Boundary

While disconnected, a runner may continue an already-authorized `INSPECT_ONLY` Agent Run, use cached context, and collect progress or evidence until its attempt deadline. A `MUTATING` attempt may continue only until its already-issued live mutation lease and bounded disconnect grace expire; it must then checkpoint and stop before further repository mutation, publish, or connector writes. No disconnected runner may assume that it acquired or renewed a lease, received a Document Write Grant, completed a task transition, or changed an external source. Such requests remain visibly pending until the server accepts them. On an `ADVISORY` trusted host this is a supervised-policy boundary, not proof that an arbitrary local subprocess or ambient credential cannot bypass the runner.

Starting a new coordinated run requires the server because duplicate execution is exactly the race MTAAP exists to prevent. If an existing run reaches a decision that needs human input, it creates a durable checkpoint and releases the execution process rather than pretending the offline client can decide for the team.

### Server Persistence and Operations

V1 uses SQLite on a persistent server volume with migrations, automated authenticated backups, and a documented restore procedure. This is enough for the target team size and keeps self-hosting to one service plus its volume. PostgreSQL is an upgrade path, not a v1 dependency.

The server stores coordination state and connector credentials, not developer git credentials, source checkouts, agent processes, or durable raw terminal output. Connector and refresh credentials use envelope encryption with a deployment master key supplied outside the SQLite volume and backup destination; data-encryption keys are versioned per credential class and may be rotated without rewriting unrelated coordination history. Backups contain ciphertext, integrity metadata, schema version, and a key identifier, never the master key. A backup is not considered successful until its authentication tag and restore manifest verify.

The documented restore drill starts in an isolated target, verifies backup integrity and schema compatibility before opening network listeners, restores with an explicitly supplied master key, invalidates server sessions and short-lived capabilities, increments connector and runner authority epochs, and requires owners to review or reauthorize external connectors before queued mutations resume. Losing the encryption key is reported as unrecoverable credential loss rather than bypassed; restoring an old backup cannot resurrect a revoked token or permit. Key rotation, backup retention and deletion, restore time, and connector reauthorization outcomes are audited. Local runner communication uses the paired runner identity, sender-constrained short-lived access tokens, and short-lived Run Capabilities over the outbound WSS channel. Connector webhooks and outbox events are idempotent so retries are safe.

### Operational Bounds V1

V1 ships finite defaults for every security-sensitive lifetime and buffer. Deployments may configure them only within positive validated ranges, and an Agent Run snapshots every effective bound that governs it so a later configuration change cannot widen work already in progress.

| Policy | Default |
|---|---:|
| Team invitation expiry | 48 hours |
| Invitation exchange session | 15 minutes |
| Fresh privileged verification | 5 minutes |
| Browser idle / absolute session | 12 hours / 7 days |
| Recovery session | 15 minutes |
| Dispatch Permit lifetime | 30 seconds |
| Authority Session lifetime / renewal cadence | 30 seconds / 10 seconds |
| Mutation disconnect grace | 15 seconds |
| Runner heartbeat / offline / lost grace | 10 / 30 / 90 seconds |
| Structured WSS frame | 64 KiB |
| Live output chunk / in-memory reconnect buffer | 16 KiB / 1 MiB per attempt |
| Runner reconnect maximum backoff | 30 seconds |
| Source-unavailable automatic refresh grace | 5 minutes |
| Encrypted local diagnostic tail | 2 MiB and 24 hours |
| Resolved Inbox retention | 90 days |

No infinity value, zero sentinel, disabled deadline, unbounded retry, or unbounded output mode is valid. A deployment may lower a bound immediately for future work. Raising a ceiling affects only newly created sessions, attempts, runs, or workflow executions.

## Dogfood Delivery Slices and Exit Criteria

The specification describes one v1, but implementation should reach it through four vertically usable slices. A later slice may begin behind a feature flag, but the team does not call an earlier slice complete from schema or static UI alone.

1. **Foundation: one secure shared run**
   - Ship first-run bootstrap, passkey login and recovery, one project, owner-only runner pairing, Native and Orca host support, Personal Run Presets, source-free `ONCE` runs, Execution Authority, live run and attempt state, cancellation, checkpoints, Published Git References, and safe worktree cleanup.
   - Exit when both owners can start headless and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server backup and isolated restore drills pass; and one week of dogfood produces no need for direct database repair.

2. **GitHub coordination: work reaches delivery**
   - Add the GitHub App, issue and pull-request projections and mutations, Milestones, selected GitHub Projects, Assignment versus Delegation, canonical Coordination Records, mutation guards, diff evidence, GitHub checks, Inbox, and Command Center.
   - Pull-request review and merge remain GitHub operations in v1. Collab links to them, reconciles their authoritative state, and records the resulting evidence; it does not gain an unlisted review-submission or merge mutation.
   - Exit when a real connected issue can be triaged, assigned, delegated, implemented, published with a closing reference, reviewed, merged, and observed closing from GitHub without Collab fabricating source state; missed webhook reconciliation, stale replace-style edits, late source linking, and connector scope narrowing are exercised successfully.

3. **Outline collaboration: knowledge is genuinely bidirectional**
   - Add federated Outline search and reading, delegated member OAuth, bot-authored agent operations, visible Context Read Scopes, direct human editing, Document Write Grants, proposal/conflict handling, External Working Documents, and grant/connector revocation.
   - Exit when two members can co-edit an Outline document through Collab with correct native attribution; an agent can iterate only inside an exact grant; concurrent external edits create a conflict proposal; revoked member and bot grants stop new external operations; and no raw document body appears in run logs, backups outside encrypted connector storage, or runner outboxes.

4. **Bounded automation: workflows earn their complexity**
   - Add Team Run Templates, Personal Workflow Presets, the React Flow editor, typed results, parallel inspect-only review, joins, human decisions, conditional fixes, repository-defined gates, Managed Loops, and full deadline and revocation behavior.
   - Exit when the team dogfoods **Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal** on a real pull request with different runtimes or models per step; validation catches missing terminal and fix paths; restart and duplicate events create no duplicate run; pause and waiting do not extend the deadline; and no process remains parked for a human decision.

## V1 Feature Decisions and Deliberate Deferrals

The earlier opportunity list is resolved below. Each item records the chosen v1 surface and any deliberately deferred expansion rather than remaining an uncommitted feature wishlist.

1. **Git Worktree Isolation — V1**
   - Each concurrent Agent Run uses a separate git worktree on a dedicated branch; sequential attempts within one run reuse it.
   - Prevents conflicts when multiple durable goals operate on the same repository in parallel without losing retry or loop state.
   - The original project hinted at this but did not implement it deeply.

2. **Durable Agent Run Checkpoints — V1; Full Replay Deferred**
   - Save structured, bounded state between Execution Attempts and allow the same Agent Run to continue after process exit, crash, or runner restart when its pinned worktree remains available.
   - Preserve lifecycle, evidence, configuration provenance, and git artifacts for inspection, but defer terminal reconstruction and deterministic historical execution replay.

3. **Advisory Source Dependencies — V1; Enforcement Deferred**
   - Project source-native dependency state into the Coordination Record and launch flow with freshness and authoritative links.
   - Warn about unresolved, unavailable, or stale dependencies without blocking launch or automatically changing the Agent Run lifecycle.

4. **Automatic Run Workflows — V1**
   - A Team Workflow Template defines portable typed steps, bounded `INSPECT_ONLY` parallel groups, `ALL` or `ANY` joins, and transitions through a React Flow canvas backed by the canonical Collab schema; a Personal Workflow Preset binds each agent step to a Personal Run Preset with its own CLI, model profile, runner, host, and mode.
   - A Workflow Execution creates distinct linked Agent Runs for implementation, parallel or sequential review, conditional fixes, and repeated bounded review without parsing logs, parallelizing mutating steps, or keeping processes parked between steps.

5. **Policy-Driven Diff Review — V1**
   - Every mutating run records bounded diff and verification evidence without storing raw source diffs in Collab.
   - Run Templates may require a non-blocking human gate; Workflow Templates may launch separate automatic Review and Fix Runs. Approval is not universal or silently inserted.

6. **Repository-Defined Quality Gates — V1**
   - A version-controlled `.collab/gates.toml` defines arbitrary repository-specific local commands, GitHub checks, and named Gate Sets without requiring code plugins.
   - Local recipes are loaded from the trusted base revision and require per-runner fingerprint approval; templates request names, never transmit commands, and every result is bound to an exact revision.

7. **Personal Run Presets and Explicit Selection — V1**
   - Users save recurring runner, host, mode, profile, context, and execution-policy choices as transparent Run Presets.
   - Projects may preselect a user-chosen default, but v1 performs no automatic cheapest-model or hidden runner routing.

8. **Reference-First Context Recipes — V1**
   - Versioned recipes place bounded identifiers, revisions, paths, summaries, and optional small previews in the bootstrap envelope rather than preloading full repositories and connected-source bodies.
   - Agents retrieve full authorized details on demand through their worktree, local tools, or run-scoped MTAAP tools; each retrieval records provenance without copying the body into durable coordination state.

9. **Team Run Templates — V1**
   - Portable, versioned single-run patterns pre-fill goals, context rules, autonomy policy, bounds and quality gates without containing runner-local command details.
   - Members bind them to eligible Personal Run Presets explicitly; existing runs and personal choices never change when a template is updated.

10. **Best-Effort Usage Telemetry — V1**
    - Always record execution and gate duration, runtime, profile and declared model provenance; record token categories only when a reviewed adapter reports them structurally.
    - Preserve `UNKNOWN` and coverage for partial data. Defer currency estimates, budgets, quotas, billing and automatic cost-based routing.

11. **Repository Conflict Detection — V1**
    - Combine the Work Item Mutation Guard with bounded Changed-Path Snapshots and target-branch overlap detection across otherwise unrelated Coordination Records.
    - Surface advisory Repository Collisions without preventing safe parallel work in separate Agent Run Worktrees or retaining path history indefinitely.

12. **Portable Planning Workflows — V1**
    - Planning is an optional `INSPECT_ONLY` Agent Run step producing a typed Plan Artifact, followed by either automatic implementation or a durable human approval gate.
    - Each step may use a different CLI, model, runner, host and mode. Native CLI planning flags remain local profile behavior rather than a false universal `planMode` switch.

## Glossary

- **MCP**: Model Context Protocol. A protocol that lets AI agents discover and call tools.
- **Work Source**: The system that owns the intent and native lifecycle of a work item, such as GitHub Issues, Linear, or Beads.
- **Source Projection**: MTAAP's refreshable, non-authoritative view of selected fields and current state from a Work Source or Context Source. It never outranks the source response.
- **GitHub Milestone Projection**: The refreshable GitHub-authoritative repository planning metadata attached to eligible issues and pull requests, including title, description, state, due date, and derived issue counts. It is neither a Collab deadline nor an Agent Run lifecycle.
- **GitHub Project Projection**: The allowlisted, refreshable view of one existing organization-owned GitHub Project's eligible issue and pull-request items, field definitions, supported values, and provenance. It remains constrained by the connected-repository intersection and never becomes a second Collab backlog.
- **Assignment**: The GitHub-authoritative choice of one or more human assignees accountable for an issue. It is independent from agent execution.
- **Delegation**: The explicit creation of an Agent Run to pursue a Run Goal for a project, optionally anchored to a source item or prior run. It does not require or change a work source's human assignees.
- **Collab Member Identity**: The immutable internal actor to which one or more verified login-provider identities may be deliberately linked. Project authorization and audit history attach to this actor rather than directly to an email address or proxy header.
- **Team Invitation**: An owner-issued, expiring, single-use authorization to join one Collab team after authenticating through an enabled provider. It is stored only as a hash, grants no reusable session by itself, and does not require an email delivery service.
- **Owner**: A Collab Member with deployment and team administrative authority over authentication, connectors, invitations, membership, roles, and settings. V1 permits multiple owners but never zero.
- **Member**: A trusted collaborator with full day-to-day authority inside every project but no ability to change the deployment's membership or security boundary. Runner ownership remains independent from this role.
- **Single-Team Deployment**: The v1 trust boundary in which one `collab-server` contains one team and any number of projects. Separate trust groups use separate deployments rather than logical tenants inside the same process.
- **Team-Wide Project Access**: The rule that every active team member may see and collaborate in every project on the deployment. Projects organize work and connector scopes but do not create human access partitions.
- **Source Membership Alignment**: The owner-maintained expectation that everyone invited to the Collab team is trusted with every connected source. V1 surfaces mismatches but does not synchronize team membership with GitHub or another external access model.
- **Notification Inbox**: The durable per-member list of deduplicated attention, blockage, warning, and outcome events. It links to authoritative subjects and keeps personal read state without inventing another work lifecycle.
- **Operational Board**: The shared, derived Command Center view grouping live coordination subjects into attention, active, waiting, and recent lanes. Its cards move from authoritative events and are never a second draggable task lifecycle.
- **Run Preset**: A server-stored, user-owned template for visible Agent Run choices such as host, mode, profile reference, policy, bounds, context, gates, and reusable instructions. It never contains or widens runner-local command details and snapshots into the created run.
- **Team Run Template**: A versioned, team-visible and portable workflow definition containing intent, variables, context rules, generic execution requirements, autonomy policy and gates without private runner bindings or runner-local command details.
- **Effective Run Configuration**: The immutable safe snapshot of the visible template, preset, profile version, execution choices, bounds, grants, gates and provenance used to create one Agent Run. It excludes runner-local secrets and command configuration.
- **Context Recipe**: A versioned, budgeted selection policy for the reference identifiers, revisions, instruction paths, concise summaries, predecessor evidence, and optional previews placed in one Agent Run's bootstrap envelope. It narrows context assembly but grants no new source access.
- **Bootstrap Envelope**: The small initial context delivered with an Agent Run's goal and instructions, containing authorized retrieval references and bounded orientation rather than eagerly copied source bodies, repository files, diffs, or broad history.
- **Usage Telemetry**: Non-billing operational measurements for execution duration, counts, runtime and profile provenance, plus adapter-reported provider units when trustworthy. Unknown or partial coverage remains explicit and is never converted into estimated currency cost in v1.
- **Context Source**: A system that owns documents or notes which can be searched, linked, and explicitly attached to agent work without transferring ownership to MTAAP.
- **Context Read Scope**: The project-level allowlist of areas in connected Context Sources that Agent Runs may search and read without per-item approval, still bounded by the source system's native permissions.
- **Execution Environment**: The developer-controlled system that owns live agent execution, worktrees, terminals, and processes, such as Orca or a native CLI runner.
- **Execution Host**: The runner-local `NATIVE` or `ORCA` adapter that starts, cancels, reconciles, and optionally exposes local attachment for one Prepared Execution. Host selection is independent from agent runtime and Interaction Mode.
- **Interaction Mode**: The generic `HEADLESS` or `INTERACTIVE` execution choice for one Execution Attempt. Headless requires no human terminal input; interactive permits local terminal interaction without implying Native, Orca, or current human presence.
- **Local Presence**: The live `ATTACHED` or `DETACHED` state of an interactive local terminal beneath one Execution Attempt. It is observable status rather than an Interaction Mode or lifecycle.
- **Local Interactive Security Boundary**: The security property that all human terminal interaction for an `INTERACTIVE` attempt remains on its runner machine. The shared server exposes status and typed controls but never proxies a terminal or its keystrokes.
- **Runner Dispatch Audience**: The owner-controlled `OWNER_ONLY` or `TEAM` policy deciding who may request new Execution Attempts on one Registered Runner. It is independent from runtime, Execution Host, and Interaction Mode.
- **Team Dispatch Exposure**: One explicit, versioned project mapping and opaque Custom Launch Profile version pair made available on a `TEAM` runner to every current Collab team member after the required acknowledgement.
- **Dispatch Permit**: A short-lived, single-use authorization for one exact Execution Attempt, bound to the dispatcher, runner and owner, runner epoch, mapping and profile versions, host, mode, and dispatch-policy revision and revalidated by the runner before process creation.
- **Execution Authority**: The deep shared-server module that atomically authorizes launches and later attempts, consumes single-use permits, issues and renews fenced Authority Sessions, authorizes sensitive operations, applies revocation, and returns one stable policy-decision vocabulary to web, CLI, MCP, workflows, and runner transport.
- **Authority Session**: The short-lived fenced authority held by one active Execution Attempt after permit consumption. It snapshots exact actor, runner, repository, mapping, profile, connector, approval, policy, and lease revisions and must be live for mutating or external operations.
- **Repository Assurance**: The visible `ADVISORY` or `ENFORCED` strength behind a Repository Mode. Advisory coordinates a trusted process and withholds Collab capabilities without claiming sandbox isolation; Enforced requires a technical execution adapter that prevents prohibited operations.
- **Approval Subject**: The immutable exact resource and decision covered by one human approval, including its identifiers, revisions or commit SHAs, evidence and configuration digests, and allowed transition. Any subject change makes the approval stale.
- **Federated Command Center**: MTAAP's product role as the shared surface that connects authoritative work sources, context sources, and personal execution environments without replacing them.
- **Federated Search**: A live fan-out query across connected authoritative sources whose results are normalized by MTAAP without first ingesting their full content into a central index.
- **MTAAP Bot Identity**: The single integration identity used for agent operations in one connected Outline workspace. Source history attributes automation to this identity, while MTAAP records the exact run-level provenance.
- **Coordination Record**: MTAAP's project-scoped durable thread grouping related Agent Runs, optional source and context references, pull requests, mutation guards, evidence, and provenance. Every run has one, but the record has no task lifecycle and requires no external work item. Each connector-owned actionable source item maps to exactly one canonical record per project.
- **Repository Mode**: The declared `MUTATING` or `INSPECT_ONLY` repository authority of one Agent Run. Inspect-only runs may coexist but may not silently publish code changes.
- **Work Item Mutation Guard**: The shared-server rule that permits one active `MUTATING` Agent Run per Coordination Record by default while allowing concurrent `INSPECT_ONLY` runs and explicit, audited overrides.
- **Changed-Path Snapshot**: The latest bounded set of normalized repository-relative paths changed by one Agent Run, reported without contents or absolute machine paths solely for collision detection. After the run becomes terminal, it remains only while a linked pull request is open or Retained Local Work exists.
- **Repository Collision**: An advisory warning that two otherwise independent Agent Runs in the same repository report at least one overlapping changed path. It never merges, pauses, or cancels either run automatically.
- **Collision Audit Record**: The durable, path-free fact that a Repository Collision occurred, including the involved runs, times, overlap count, and acknowledgement or resolution metadata without retaining repository structure.
- **Agent Run Lifecycle**: The fixed `QUEUED`, `RUNNING`, `WAITING`, `COMPLETED`, `FAILED`, and `CANCELLED` states for one outcome-oriented agent activity. It is independent from the Work Source's native state and the pull request's GitHub state.
- **Team Workflow Template**: A portable, versioned definition of named Team Run Template steps, typed inputs and results, transitions, human decisions, completion conditions, and hard orchestration bounds without personal runner or profile bindings.
- **Workflow Definition**: The canonical typed and executable schema for one Team Workflow Template version. It contains semantic nodes, transitions, contracts, joins and bounds but no React Flow objects, viewport geometry, or personal execution bindings.
- **Canvas Layout**: Non-executable presentation metadata for rendering a Workflow Definition in React Flow, including positions, viewport and collapsed groups. It is revisioned separately from semantic version identity and can never change execution behavior.
- **Personal Workflow Preset**: A member-owned binding of every agent step in a Team Workflow Template version to a compatible Personal Run Preset version, or an entirely personal composition of Personal Run Presets. Each step may therefore select a different runtime, model profile, runner, host, and interaction mode.
- **Workflow Execution**: A durable orchestration instance under one Coordination Record that launches and links distinct Agent Runs according to one immutable Workflow Template and Preset snapshot. It owns transition and bound state but no process, terminal, worktree, or runtime lifecycle.
- **Workflow Step Result**: A typed result validated against a Team Run Template's versioned result contract and durably attached to a terminal Agent Run. Workflow transitions may consume it; logs, prompts, transcript text, and process exit codes cannot substitute for it.
- **Parallel Step Group**: A bounded Workflow Execution fan-out containing only `INSPECT_ONLY` Agent Run steps, each with independent execution configuration and typed results against shared immutable input references. Mutating steps cannot be parallelized under one Coordination Record.
- **Workflow Join**: The typed `ALL` or `ANY` policy that serializes completion of one Parallel Step Group and exposes keyed result artifacts or a required fallback without parsing or implicitly merging branch prose. Every `ANY` join also declares `CANCEL_REMAINDER` or `LET_FINISH` for losing branches.
- **Plan Artifact**: The bounded, human-visible authored result of an `INSPECT_ONLY` Planning Run, containing approach, assumptions, risks, affected areas, and verification strategy either directly in Collab or through an authorized versioned document reference. It is portable input to a later Implementation Run rather than hidden process memory.
- **Diff Evidence**: The bounded base/head identifiers, dirty state, changed paths, file and line statistics, Published Git Reference, and verification provenance recorded for a mutating Agent Run without persisting its raw source diff in Collab.
- **Review Policy**: The visible effective choice that requires no approval, a durable human diff gate within one Agent Run, or separate automatic Review and conditional Fix Runs in a Workflow Execution. It never parks an agent process while awaiting another actor.
- **Durable Checkpoint**: A bounded, structured recovery record between Execution Attempts containing progress, reason, requested action, safe evidence, relevant revisions, and resume guidance. It supports continuation of the same goal and worktree without claiming to restore process or model memory.
- **Recoverable Remote Reference**: The most recent remote ref and exact commit SHA whose reachability the runner verified for a run. It is the honest portable continuation boundary when runner-local checkpoint or worktree state is unavailable.
- **Run Result**: The canonical typed `DELIVERED`, `NO_CHANGES`, `BLOCKED`, or `ESCALATED` claim submitted after useful attempt work, with bounded evidence. It is evaluated by coordination policy and never inferred from process exit code or prose.
- **Run Goal**: The explicit outcome one Agent Run is responsible for, such as implementation, review, a requested fix, documentation, or triage. A materially different outcome requires a new run rather than repurposing completed history.
- **Shared Coordination Server**: The always-on, self-hostable authority for MTAAP-owned coordination state used by the web, CLI, MCP, connectors, and local runners.
- **Local Runner Cache**: A bounded, non-authoritative local copy of recently retrieved coordination context used only to keep an already-started execution useful during a short outage.
- **Durable Outbox**: The local queue of idempotent run events that a runner retries after reconnecting without treating queued transitions as committed.
- **Registered Runner**: A developer-controlled local runner known to the shared server through its immutable owner, supported adapters, project mappings, Runner Dispatch Audience, policy revision, runner epoch, and heartbeat. Registration enables explicit dispatch but does not transfer local credentials or execution authority to the server.
- **Shared Runner**: A Registered Runner with `TEAM` dispatch audience and at least one Team Dispatch Exposure. It remains owner-controlled and private for every mapping and profile not explicitly exposed.
- **Run Capability**: A short-lived, audience-restricted credential authorizing one agent process to perform only the MTAAP operations allowed for one Agent Run.
- **Runner Data Plane**: The outbound-only, authenticated, replay-resistant channel that carries typed runner control messages, structured events, and ephemeral live output without exposing an inbound listener or remote shell.
- **Execution Adapter**: A runner-local implementation for one supported agent CLI that validates Custom Launch Profiles, prepares host-neutral invocation and prompt behavior for supported Interaction Modes, and interprets runtime output without owning Execution Hosts, worktrees, process lifecycle, or server coordination.
- **Bundled Execution Adapter**: An Execution Adapter included in and versioned with a reviewed runner release. V1 runners load only bundled adapters and never fetch adapter implementation code in response to server or project input.
- **Prepared Execution**: The immutable, runner-local, host-neutral invocation produced by an Execution Adapter after profile and Interaction Mode validation. It describes executable resolution, arguments, prompt delivery, runtime output interpretation, and bounded requirements while leaving Native or Orca session creation, environment assembly, worktree authority, supervision, and lifecycle transitions to the runner.
- **Custom Launch Profile**: A versioned, runner-owner-controlled configuration for one supported Execution Adapter containing local invocation recipes, prompt transport, capability defaults, and execution limits for one or both Interaction Modes. It never owns task or workflow instructions. Execution Host selection remains orthogonal; the server may select a shared profile but may not supply or widen its command, and v1 has no generic arbitrary-executable profile.
- **Agent Run**: A durable project-scoped agent activity with one Run Goal and required Coordination Record plus optional source item, pull request, or predecessor references. It owns execution coordination state and may span one or many Execution Attempts, including loop iterations, restarts, and resumptions.
- **Runtime-Owned Loop**: Repeated behavior requested by visible Run Preset, Team Run Template, or per-run instructions and implemented inside one agent CLI process. Its Custom Launch Profile controls only invocation and prompt transport. Collab supervises it as one bounded Execution Attempt and does not invent per-tick lifecycle records it cannot observe reliably.
- **Managed Loop**: An explicit Agent Run policy in which the shared server durably schedules and evaluates sequential Execution Attempts against the same goal and worktree, with refreshed context and visible per-iteration evidence.
- **Loop Bounds**: The non-optional limits that make repeated execution finite. A Managed Loop has a semantic stop condition, maximum attempt count, and absolute deadline; a Runtime-Owned Loop has at least an absolute deadline because its internal ticks are opaque.
- **Managed Loop Stop Policy**: A versioned, typed condition tree evaluated by the shared server before scheduling another managed iteration. It combines authoritative source predicates, canonical Agent Outcomes, Boolean composition, and durable consecutive-match counters without executing user code.
- **Agent Outcome**: A runtime-neutral `CONTINUE`, `GOAL_ACHIEVED`, or `ESCALATE` event emitted with reasons and evidence by an Execution Attempt. It affects a Managed Loop only through its selected Stop Policy and never overrides hard limits or authoritative source state.
- **Agent Run Worktree**: The dedicated runner-local git worktree and branch owned by one Agent Run and reused by its sequential Execution Attempts. Its creation pins the Agent Run to that Registered Runner; separate Agent Runs never share this mutable working state.
- **Retained Local Work**: An Agent Run Worktree kept after its run became terminal because it is dirty, unpublished, or could not be removed safely. It has no automatic expiry in v1 and only its Registered Runner's owner may discard it.
- **Published Git Reference**: The configured remote ref and commit SHA that a runner has verified contain an Agent Run's `HEAD`. It is the durable code handoff that permits safe removal of a clean terminal Agent Run Worktree without waiting for pull-request merge.
- **Execution Attempt**: One concrete runner-supervised agent-runtime operating-system process or interactive session invocation beneath an Agent Run, following the fixed `PENDING`, `STARTING`, `RUNNING`, `EXITED`, `FAILED_TO_START`, `CANCELLED`, `TIMED_OUT`, and `LOST` lifecycle. Runtime-owned internal ticks remain one attempt; each Managed Loop agent process is another; quality-gate processes are Gate Evaluations instead. Its lifecycle, exit code, Agent Outcome, and evidence are distinct facts rather than a success label, and only the Agent Run represents goal success or failure.
- **Project Gate**: One repository-defined verification operation declared in the trusted `.collab/gates.toml` manifest as either an owner-approved runner-local command array or a GitHub Check observation, with fixed bounds and an exact-revision result.
- **Project Gate Set**: A named ordered collection of repository-local Project Gates requested by a Run or Workflow Template. Personal configuration may add gates but cannot remove or redefine a required set.
- **Gate Evaluation**: One durable evaluation of a Project Gate for an Agent Run, exact repository revision, and approved manifest fingerprint. It records typed local-process or GitHub-check evidence and becomes stale when the evaluated head changes.
- **Document Write Grant**: Authorization from any Collab project member allowing one Agent Run to make repeated non-destructive content edits to named existing documents without per-change approval.
- **External Working Document**: An optional human-visible document used as a shared canvas by one Agent Run and its collaborators. It is not authoritative project knowledge merely because an agent wrote to it.
- **Agent Spawning**: The act of invoking a CLI agent (e.g., `claude -p`) with the task context and instructions.
- **Semantic Contract**: The separate meanings encoded in source projections, the Agent Run lifecycle, pull-request state, and MCP tool names, independent of any agent implementation.

## Appendix: Evidence from the Original Repository

- Original scope and vision: `mtaap-collab-scope.md`.
- Task lifecycle and MCP tools: `apps/mcp/README.md` and `docs/epics/EPIC-009-mcp-tools.md`.
- Git integration design: `docs/epics/EPIC-010-git-integration.md`.
- Plugin/integration RFC: `docs/rfcs/RFC-001-integration-plugin-system.md`.
- Deployment readiness analysis: `docs/SAAS-DEPLOYMENT-BLOCKERS.md`.
- Desktop companion concept: `docs/collab-agent.md` and `apps/collab-agent/README.md`.
- Transport baseline: [OWASP Transport Layer Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html) and [WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).
- Token replay and sender constraints: [IETF RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) (OAuth 2.0 Security Best Current Practice) and [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) (DPoP).
- GitHub issue closure behavior: [Linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) and [Managing automatic closing of issues](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-auto-closing-issues).
- GitHub planning surfaces: [GitHub App permissions for organization Projects](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [Projects GraphQL reference](https://docs.github.com/en/graphql/reference/projects), and [Milestones REST API](https://docs.github.com/en/rest/issues/milestones?apiVersion=2022-11-28).
- Visual workflow authoring: [React Flow overview](https://reactflow.dev/), [connection validation](https://reactflow.dev/examples/interaction/validation), [subflows](https://reactflow.dev/learn/layouting/sub-flows), [save and restore](https://reactflow.dev/examples/interaction/save-and-restore), and [performance guidance](https://reactflow.dev/learn/advanced-use/performance).
- Runtime adapter evidence: [Pi modes and extension model](https://pi.dev/docs/latest), [Pi RPC mode](https://pi.dev/docs/latest/rpc), and [OpenCode CLI modes](https://dev.opencode.ai/docs/cli/).
- Orca precedent: [per-agent interactive launch strategies](https://github.com/stablyai/orca/blob/e7ee15f4b24b62a540cb8478dd590c39b5f9a34a/src/shared/tui-agent-config.ts), [prompt-aware startup planning](https://github.com/stablyai/orca/blob/e7ee15f4b24b62a540cb8478dd590c39b5f9a34a/src/shared/tui-agent-startup.ts), and [headless agent specifications](https://github.com/stablyai/orca/blob/e7ee15f4b24b62a540cb8478dd590c39b5f9a34a/src/shared/commit-message-agent-spec.ts).

---

*This document is a structured extraction of the MTAAP project's knowledge. It is intended to be a seed for the next, simpler, federated shared-coordination iteration.*
