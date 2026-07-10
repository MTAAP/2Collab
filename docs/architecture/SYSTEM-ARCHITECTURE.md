> **Authority level:** Derived explanation; does not add or amend product behavior.  
> **Canonical source:** [`PRODUCT-SPEC.md`](../product/PRODUCT-SPEC.md). If this document conflicts with the Product Spec, the Product Spec wins.

# System Architecture

## Purpose and canonical anchors

This document turns the Product Spec into stable implementation modules, dependency directions, data flows, and deployment topology. It derives from:

- [`One Language, One Repo, One Build System`](../product/PRODUCT-SPEC.md#9-one-language-one-repo-one-build-system)
- [`System Role and Authority`](../product/PRODUCT-SPEC.md#system-role-and-authority)
- [`Deployment Model`](../product/PRODUCT-SPEC.md#deployment-model)
- [`Federated Source Model`](../product/PRODUCT-SPEC.md#federated-source-model)
- [`Packaging V1`](../product/PRODUCT-SPEC.md#packaging-v1)
- [`Core Components`](../product/PRODUCT-SPEC.md#core-components)
- [`Prepared Execution Adapter Contract V1`](../product/PRODUCT-SPEC.md#prepared-execution-adapter-contract-v1)
- [`Secure Runner Data Plane`](../product/PRODUCT-SPEC.md#secure-runner-data-plane)
- [`Recommended Model: Shared Authority with Local Continuity`](../product/PRODUCT-SPEC.md#recommended-model-shared-authority-with-local-continuity)
- [`Server Persistence and Operations`](../product/PRODUCT-SPEC.md#server-persistence-and-operations)

The target is one trusted team of roughly one to three developers. The repository uses Bun and TypeScript, one root `package.json`, and at most two deployment artifacts.

## Deployment topology

```text
 GitHub / Outline
        ^
        | signed webhooks and provider calls
        v
+---------------------------------------------------------------+
| collab-server                                                 |
| Hono HTTP + MCP + webhooks | React static assets | SSE       |
| authentication | coordination | ExecutionAuthority | workflow |
| connectors | notification projections | scheduler | backup    |
|                         bun:sqlite + persistent volume         |
+------------------------------^--------------------------------+
                               | outbound-only authenticated WSS
                               | typed commands and events
              +----------------+----------------+
              |                                 |
+-------------v----------------+  +-------------v----------------+
| collab on trusted runner A   |  | collab on trusted runner B   |
| CLI + runner daemon          |  | CLI + runner daemon          |
| local cache + durable outbox |  | local cache + durable outbox |
| profiles + credentials       |  | profiles + credentials       |
| worktrees + processes        |  | worktrees + processes        |
| Native / Orca host adapters  |  | Native / Orca host adapters  |
+------------------------------+  +------------------------------+
```

Browsers and remote MCP clients never connect directly to a runner. Interactive terminal bytes never leave the runner machine.

## Deployable artifacts

| Artifact | Owns | Must not own |
|---|---|---|
| `collab-server` | Web application, authenticated HTTP and MCP transports, webhook ingestion, SSE, authentication, coordination state, workflow scheduling, connector credentials, SQLite migrations, backup and restore hooks | Developer git credentials, source checkouts, worktrees, agent processes, local launch commands, terminal history |
| `collab` | CLI, local stdio MCP bridge, runner daemon, OS credential-store integration, project registry, bounded cache, Durable Outbox, worktrees, local profiles, runtime adapters, Native and Orca host adapters, process supervision | Canonical coordination state, team membership, connector credentials, mutation-guard truth, workflow truth |

There is no third worker, connector, frontend, broker, or execution artifact. Logical modules may later be split internally without changing these two deployment artifacts or their semantic interfaces.

## Server modules

| Module | Interface responsibility | Depends on |
|---|---|---|
| `IdentityAndMembership` | Authenticate a concrete Member; manage invitations, roles, sessions, reauthentication, and offboarding epochs | SQLite, configured identity-provider adapters |
| `ProjectRegistry` | Own Collab Projects, connected source scopes, and canonical source-item mappings | SQLite, connector metadata |
| `Coordination` | Create and inspect Coordination Records; own Agent Run, Execution Attempt, checkpoint, evidence, and mutation-guard state | SQLite, `ExecutionAuthority`, projections |
| `ExecutionAuthority` | Preview and atomically authorize launches and later attempts; consume permits; fence Authority Sessions; authorize sensitive operations; apply revocation | SQLite, WSS runner-control port, GitHub and Outline authority ports |
| `WorkflowOrchestration` | Launch immutable Workflow Executions; evaluate typed transitions and joins; enforce bounds; create idempotent step intents | `Coordination`, `ExecutionAuthority`, SQLite |
| `ConnectorAuthority` | Own connector scopes and epochs; preview and commit revocation; mediate exact-revision external operations | SQLite, GitHub and Outline adapters |
| `SourceProjection` | Reconcile refreshable GitHub and Outline metadata without becoming authoritative source content | Connector adapters, SQLite |
| `NotificationProjection` | Derive Inbox items and Command Center lanes from committed events | Read-only domain projections |
| `ContextAssembly` | Build bounded Bootstrap Envelopes from authorized references and recipes | Source ports, run configuration |
| `TransportAdapters` | Translate Hono HTTP, MCP, webhook, SSE, and WSS messages to module calls and results | Zod schemas and the modules above |
| `PersistenceAndRecovery` | Migrations, authenticated backups, isolated restore, key identifiers, and epoch invalidation | `bun:sqlite`, deployment master key |

Transport adapters contain no authorization, lifecycle, connector, or workflow policy. They authenticate and validate input, call a module, and encode its typed result.

## Runner modules

| Module | Interface responsibility | Depends on |
|---|---|---|
| `RunnerRegistration` | Pair the local installation, maintain runner identity and epoch, advertise safe capabilities and heartbeats | OS credential store, WSS client |
| `RunnerSupervisor` | Consume permits, renew Authority Sessions, supervise one attempt process, enforce deadlines and output bounds, reconcile cancellation and loss | `ExecutionAuthority` protocol, worktree and adapter modules |
| `WorktreeManager` | Create one dedicated worktree and branch per Agent Run, reuse it for sequential attempts, collect diff evidence, and clean it only after safe handoff | Local git executable and repository mapping |
| `ProfileRegistry` | Store runner-owner-controlled, versioned Custom Launch Profiles and expose only safe summaries | Local configuration and credential store |
| `ExecutionAdapterRegistry` | Resolve a bundled runtime adapter and prepare a host-neutral invocation | Bundled Claude, Codex, Pi, or OpenCode adapters |
| `ExecutionHostRegistry` | Start, cancel, reconcile, and locally attach to Prepared Executions | Native and Orca host adapters |
| `LocalProjectRegistry` | Map project identifiers to local repository paths | Local database or file |
| `LocalContinuity` | Retain a bounded read cache and idempotent Durable Outbox for short outages | Local storage and WSS client |
| `LocalDiagnostics` | Retain only opt-in, encrypted, bounded local diagnostic tails and safe correlation data | OS credential store and local encrypted storage |

The runtime Execution Adapter prepares an invocation but never starts a process. The host adapter starts a Prepared Execution but never interprets runtime-specific output. `RunnerSupervisor` owns worktree selection, environment construction, deadlines, cancellation, evidence, and attempt transitions.

## Dependency direction and seams

1. Web, CLI, MCP, scheduler, webhook, and WSS adapters depend inward on domain modules.
2. Domain modules never import React, Hono request types, WSS frame types, provider response objects, shell commands, or local filesystem paths.
3. Policy evaluation remains in-process; it has no adapter seam.
4. SQLite is local-substitutable behind internal persistence seams and is tested with isolated databases. Database types do not escape module interfaces.
5. Runner control is remote-but-owned: a WSS adapter and an in-memory test adapter satisfy the same private port.
6. GitHub and Outline are true external dependencies: production and strict mock adapters satisfy narrow provider ports.
7. Native and Orca form a real runner-side host seam because both adapters exist.
8. Runtime adapters are bundled with a reviewed runner release. V1 has no dynamic or arbitrary executable adapter.

The module interface is the test surface. Tests assert observable decisions, persisted outcomes, frames, and provider calls rather than private evaluator or repository helpers.

## Primary data flows

### New run launch

1. Web, CLI, or MCP authenticates a Member and validates a launch request.
2. `ExecutionAuthority` resolves current membership, runner exposure, exact revisions, connector epochs, approvals, bounds, Repository Mode, and Repository Assurance.
3. One SQLite transaction creates the Coordination Record when needed, Agent Run, first Execution Attempt, Authority Snapshot, Dispatch Permit, mutation reservation when applicable, audit event, and WSS outbox record.
4. The WSS adapter delivers a typed `LaunchAttempt` message; it never delivers a command line.
5. The runner consumes the permit immediately before process creation, resolves its local profile, prepares the runtime invocation, selects Native or Orca, and starts supervision.
6. Structured events return through WSS and are committed before SSE projects them to browsers.

### External source operation

1. A caller requests a typed GitHub or Outline operation.
2. The server rechecks Member authority, connector epoch, scope, Authority Session where applicable, and exact resource revision.
3. The connector adapter calls the provider.
4. The server stores the confirmed result or a visible pending/failure state and later reconciles provider truth.

No local optimistic copy becomes source truth. Provider limitations leave a documented residual race between the final check and provider commit.

### Offline continuity

- An already-authorized `INSPECT_ONLY` attempt may use cached context and queue idempotent structured events until its deadline.
- A `MUTATING` attempt may continue only until its live lease and bounded disconnect grace expire, then must checkpoint and stop before further mutation, publish, or connector writes.
- A disconnected runner cannot create a coordinated run, acquire or renew authority, approve a transition, or claim an external mutation succeeded.
- Reconnection deduplicates outbox events and revalidates every requested transition.

## Persistence and secrets

- SQLite on one persistent server volume is authoritative for the single team.
- Connector and refresh credentials use envelope encryption. The deployment master key is outside the SQLite volume and backup destination.
- Backups contain ciphertext, integrity metadata, schema version, and key identifiers, never the master key.
- Restore occurs in isolation before opening network listeners, invalidates sessions and short-lived capabilities, increments connector and runner epochs, and requires connector review before queued writes resume.
- Raw terminal streams, interactive transcripts, flattened prompts, fetched source bodies, environment dumps, developer credentials, and worktree contents are never durable server data.

## Architecture invariants

- GitHub and Outline own their native content and permissions; projections never replace them.
- The server owns coordination truth; the runner owns live execution truth.
- One Agent Run owns one worktree and sequential attempts; distinct runs never share mutable local state.
- Runtime, Execution Host, Interaction Mode, Runner Dispatch Audience, Repository Mode, and Repository Assurance remain independent axes.
- React Flow nodes and Canvas Layout are presentation data; Workflow Definition is the executable schema.
- A zero process exit code is evidence, not goal completion.
- The server never sends arbitrary executable paths, shell commands, argument escape hatches, caller-controlled working directories, environment dumps, or credentials to runners.
- No automatic runner load balancing or silent redirection occurs.

## Deliberate exclusions

No multi-tenancy, billing, project ACLs, alternate authoritative database, broker, external worker fleet, plugin marketplace, dynamic execution adapters, server-hosted execution, remote shell, browser terminal, or durable transcript store belongs in v1.
