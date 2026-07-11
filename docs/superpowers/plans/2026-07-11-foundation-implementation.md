# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `FND-001` through `FND-019` as one secure source-free Agent Run spanning two owners, trusted Native/Orca runners, web/CLI/MCP surfaces, and recoverable SQLite operations.

**Architecture:** `collab-server` owns identity, coordination, authority, connector credentials, projections, SQLite, and operations; `collab` owns device credentials, repository discovery, runner supervision, worktrees, runtimes, hosts, local continuity, and the stdio MCP bridge. All callers cross the three-entry `ExecutionAuthority` interface; SQLite stays behind an internal seam, runner WSS uses production and in-memory adapters, and true-external identity/connector providers use production and strict mock adapters.

**Tech Stack:** Bun 1.3.10, TypeScript 7.0.2, Hono 4.12.29, React 19.2.7, Vite 8.1.4, Zod 4.4.3, `bun:sqlite`, `@simplewebauthn/server` 13.3.2, `@modelcontextprotocol/sdk` 1.29.0, Bun test, Playwright 1.61.1, Docker Compose.

## Global Constraints

- Use Bun 1.3.10 for installs, scripts, tests, builds, and local tooling; keep one root `package.json` and one `bun.lock`.
- Pin every dependency to one exact version; do not add npm, pnpm, Yarn, workspaces, Turborepo, an ORM, PostgreSQL, Redis, or a second build graph.
- Follow `shared contracts <- domain <- server or runner modules <- adapters and composition roots`; React, Hono, provider payloads, WSS frames, shell commands, and absolute paths never enter domain interfaces.
- Write the failing Bun test before executable behavior and confirm a behavioral RED before the smallest GREEN implementation.
- Every write command carries an idempotency key, authenticated actor, expected revisions, and a structured `Result`; persisted enum-like values are UPPERCASE.
- Secret-producing commands persist only a replay marker and a secret-free result projection; bootstrap, invitation, recovery, and permit cleartext must never enter generic idempotency result storage.
- User-facing errors use stable uppercase codes, bounded safe messages, retry disposition, and safe scalar details; never echo secrets, provider errors, commands, environment values, source bodies, diffs, or paths.
- Durable server storage may contain bounded authored input, references, revisions, hashes, lifecycle events, typed results, checkpoints, audit, and evidence; it must not contain raw terminal output, interactive transcripts, flattened prompts, fetched source bodies, raw diffs, credentials, private profile arguments, absolute paths, or worktree contents.
- Native and Orca trusted-host enforcement reports `ADVISORY`; `ENFORCED` fails closed until a real isolation adapter exists.
- Interactive bytes remain local. Headless live output is bounded, redacted, ephemeral, and absent from SQLite, backups, and outboxes.
- Operational defaults are positive and finite: invitation 48h, invitation exchange 15m, fresh verification/WebAuthn challenge 5m/5m, browser idle/absolute 12h/7d, recovery 15m, host recovery code 10m, OIDC transaction 10m, device/runner pairing and device access 10m, device refresh idle/absolute 30d/90d, DPoP clock/replay 5m/10m, permit 30s, authority session/renewal 30s/10s, mutation disconnect grace 15s, heartbeat/offline/lost 10s/30s/90s, WSS frame 64KiB, WSS runner/run rates 100/50 per second with 200/100 bursts, WSS queue 1,024 frames/1MiB, future clock allowance 30s, output chunk/buffer 16KiB/1MiB, reconnect backoff 30s, source refresh grace 5m, diagnostic tail 2MiB/24h.
- External/timed evidence remains honestly `IN_PROGRESS` until executed; its absence does not block implementation of subsequent phases.
- Do not push, merge, release, mutate production integrations, or post public comments without explicit authority.

---

## Exact File Map

| Area | Files |
|---|---|
| Shared contracts | `src/shared/contracts/{result,ids,actors,commands,execution-authority,runs,identity,projects,runners,protocol,presets,context,telemetry}.ts` |
| Database | `src/server/db/{connection,transaction,migrate}.ts`, `src/server/db/migrations/0001_foundation.sql`, `0001_foundation.verify.ts`, `0002_runners.sql`, `0002_runners.verify.ts`, `0003_runs_authority.sql`, `0003_runs_authority.verify.ts`, `0004_foundation_operations.sql`, `0004_foundation_operations.verify.ts` |
| Identity | `src/server/modules/identity/{contract,identity-authority,passkeys,invitations,recovery,revocation,sessions,csrf,devices,oidc,auth-proxy,provider-links}.ts` |
| Connector foundation | `src/server/modules/connectors/{credentials,epochs,scope-policy}.ts` |
| Projects | `src/server/modules/projects/{contract,project-registry}.ts`, `src/runner/repository/{config,discovery,global-registry}.ts` |
| Runners | `src/server/modules/runners/{contract,runner-registry,exposures}.ts`, `src/server/adapters/wss/{protocol,runner-channel,revocations}.ts`, `src/runner/{daemon,supervisor,local-diagnostics}.ts` |
| Runner adapters | `src/runner/adapters/runtime/{contract,claude,codex}.ts`, `src/runner/adapters/host/{contract,native,orca}.ts`, `src/runner/adapters/enforcement/{contract,trusted-host}.ts` |
| Authority and coordination | `src/server/modules/execution-authority/{contract,execution-authority,policy,fencing,revocation}.ts`, `src/server/modules/runs/{lifecycle,checkpoints,evidence,results,event-deduplication,reconciliation}.ts`, `src/server/modules/coordination-records/{canonical-key,registry,source-links}.ts` |
| Run configuration | `src/server/modules/presets/{personal-run-presets,configuration-resolver}.ts`, `src/server/modules/context/context-recipes.ts`, `src/server/modules/telemetry/usage.ts` |
| Worktrees | `src/runner/repository/{worktrees,publish,cleanup}.ts` |
| Surfaces | `src/server/adapters/http/routes/{bootstrap,auth,members,projects,runs,runners,presets}.ts`, `src/server/adapters/http/middleware/{session,csrf}.ts`, `src/server/adapters/http/sse.ts`, `src/server/adapters/mcp/{server,tools}.ts`, `src/cli/commands/{init,projects,status,start,cancel,resume,runner,preset,mcp}.ts`, `src/web/features/{setup,members,runs,runners,presets}/` |
| Continuity and operations | `src/runner/{cache,outbox,offline-policy}.ts`, `src/server/operations/{backup,restore,key-rotation}.ts`, `src/server/commands/{backup,restore,key-rotation,auth-recover}.ts` |
| Composition | `src/server/{app,index}.ts`, `src/cli/{command,index}.ts`, `src/web/app.tsx`, `src/shared/environment.ts`, `package.json`, `bun.lock`, `Dockerfile`, `compose.yaml` |
| Tests and evidence | `tests/unit/{architecture,identity,projects,runs,execution-authority,configuration}/`, `tests/integration/{identity,projects,runners,runs,execution-authority,surfaces,operations}/`, `tests/protocol/{runner-data-plane,surface-parity}.test.ts`, `tests/runner/`, `tests/drills/`, `tests/e2e/{setup-and-members,foundation-run}.spec.ts`, `docs/evidence/foundation/{EVIDENCE-TEMPLATE,DOGFOOD-LEDGER}.md` |

### Task 1: Shared contracts, exact dependencies, and dependency guard

**Requirements:** Foundation prerequisite; `ORP-12`.

**Files:**
- Create: `src/shared/contracts/{result,ids,actors,commands,execution-authority,runs,identity,projects,runners,protocol,presets,context,telemetry}.ts`
- Create: `tests/unit/architecture/dependency-direction.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: no product interface.
- Produces: `Result<T>`, `DomainError`, branded IDs, `CommandBase`, `CollabCommand`, `CoordinationQuery`, `ExecutionAuthority`, and external Zod schemas used by every following task.

- [ ] **Step 1: Write the failing contract and dependency tests**

```ts
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ResultSchema } from "../../../src/shared/contracts/result.ts";

describe("shared contracts", () => {
  test("accepts bounded safe errors", () => {
    expect(ResultSchema.safeParse({ ok: false, error: { code: "REVISION_CONFLICT", message: "Refresh required.", retry: "REFRESH", details: { currentRevision: 2 } } }).success).toBe(true);
  });

  test("rejects domain imports of adapters", async () => {
    for (const name of await readdir("src/domain", { recursive: true })) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(join("src/domain", name), "utf8");
      expect(source).not.toMatch(/from ["'](?:.*\/)?(?:server\/adapters|runner\/adapters|web|cli)/);
    }
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/unit/architecture/dependency-direction.test.ts`

Expected: FAIL with `Cannot find module '../../../src/shared/contracts/result.ts'`.

- [ ] **Step 3: Pin libraries and add the shared result and authority contracts**

Run: `bun add --exact @simplewebauthn/server@13.3.2 @modelcontextprotocol/sdk@1.29.0`

```ts
// src/shared/contracts/result.ts
import { z } from "zod";

export const RetryDispositionSchema = z.enum(["NEVER", "REFRESH", "EXPLICIT_RESUME", "SAME_INPUT"]);
export const DomainErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  message: z.string().min(1).max(240),
  retry: RetryDispositionSchema,
  details: z.record(z.string(), z.union([z.string().max(128), z.number().finite(), z.boolean()])).optional(),
});
export type DomainError = Readonly<z.infer<typeof DomainErrorSchema>>;
export type Result<T> = Readonly<{ ok: true; value: T; auditId?: string }> | Readonly<{ ok: false; error: DomainError; auditId?: string }>;
export const ResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown(), auditId: z.string().optional() }),
  z.object({ ok: z.literal(false), error: DomainErrorSchema, auditId: z.string().optional() }),
]);
```

```ts
// src/shared/contracts/execution-authority.ts
import type { Result } from "./result.ts";
export interface ExecutionAuthority {
  preview(request: AuthorityPreviewRequest): Promise<AuthorityPreview>;
  execute<C extends CollabCommand>(command: C): Promise<Result<CommandResultFor<C>>>;
  query<Q extends CoordinationQuery>(query: Q): Promise<Result<QueryResultFor<Q>>>;
}
export type CommandBase = Readonly<{ idempotencyKey: string; actor: MemberActor | SchedulerActor | RunnerActor }>;
export type CollabCommand = LaunchRun | AuthorizeAttempt | AcceptAttemptEvent | RecordCheckpoint | RecordEvidence | RecordRunResult | LinkSourceReference | AcknowledgeCollision | ConsumePermit | RenewAuthoritySession | AuthorizeOperation | ReleaseAuthoritySession | ReplaceRunnerPolicy | ApplyRevocation;
export type CoordinationQuery = InspectCoordinationRecord | InspectRun | InspectAttempt | InspectEvidence | InspectProjection;
export type CommandResultFor<C extends CollabCommand> = Extract<CommandResult, { kind: C["kind"] }>;
export type QueryResultFor<Q extends CoordinationQuery> = Extract<QueryResult, { kind: Q["kind"] }>;
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/unit/architecture/dependency-direction.test.ts && bun run typecheck`

Expected: PASS; TypeScript reports no missing shared contract or inconsistent generic mapping.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/shared/contracts tests/unit/architecture/dependency-direction.test.ts
git commit -m "feat: establish foundation contracts"
```

### Task 2: SQLite connection, transactions, and identity migration

**Requirements:** `FND-001`, persistence prerequisite for `FND-002` and `FND-013`.

**Files:**
- Create: `src/server/db/{connection,transaction,migrate}.ts`
- Create: `src/server/db/migrations/0001_foundation.sql`
- Create: `src/server/db/migrations/0001_foundation.verify.ts`
- Test: `tests/integration/db/foundation-migration.test.ts`

**Interfaces:**
- Consumes: `DomainError`, branded IDs.
- Produces: `openDatabase(path): Database`, `inImmediateTransaction<T>(db, operation): T`, `migrate(db): void`, schema version 1.

- [ ] **Step 1: Write the failing migration test**

```ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../../src/server/db/migrate.ts";

test("0001 creates one-team identity and audit constraints", () => {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  expect(names).toContain("deployments");
  expect(names).toContain("members");
  expect(names).toContain("audit_events");
  expect(() => db.exec("INSERT INTO deployments(id, team_id, revision, created_at) VALUES ('d2','t2',0,0)")).toThrow();
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/integration/db/foundation-migration.test.ts`

Expected: FAIL because `src/server/db/migrate.ts` does not exist.

- [ ] **Step 3: Add the migration and transaction implementation**

```sql
-- src/server/db/migrations/0001_foundation.sql
PRAGMA foreign_keys = ON;
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE deployments(id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK(singleton = 1), team_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE members(id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('OWNER','MEMBER')), status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')), authority_epoch INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE member_credentials(id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), kind TEXT NOT NULL CHECK(kind IN ('PASSKEY','RECOVERY','OIDC','AUTH_PROXY')), secret_hash BLOB, public_data TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), kind TEXT NOT NULL CHECK(kind IN ('BROWSER','RECOVERY','DEVICE','HOST_RECOVERY')), expires_at INTEGER NOT NULL, idle_expires_at INTEGER, sender_key_thumbprint TEXT, revision INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE invitations(id TEXT PRIMARY KEY, token_hash BLOB NOT NULL UNIQUE, inviter_id TEXT NOT NULL REFERENCES members(id), label TEXT, expires_at INTEGER NOT NULL, consumed_at INTEGER, revoked_at INTEGER, revision INTEGER NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE encrypted_credentials(id TEXT PRIMARY KEY, credential_class TEXT NOT NULL, key_id TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, auth_tag BLOB NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE connector_epochs(connector_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, review_state TEXT NOT NULL CHECK(review_state IN ('READY','REVIEW_REQUIRED','REVOKED')));
CREATE TABLE audit_events(id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, subject_id TEXT, safe_details TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE idempotency_results(actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(actor_id,idempotency_key));
INSERT INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());
```

```ts
// src/server/db/transaction.ts
import type { Database } from "bun:sqlite";
export function inImmediateTransaction<T>(db: Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = operation(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/integration/db/foundation-migration.test.ts src/server/db/migrations/0001_foundation.verify.ts`

Expected: PASS; an isolated database reaches schema version 1 and rejects a second deployment row.

- [ ] **Step 5: Commit**

```bash
git add src/server/db tests/integration/db
git commit -m "feat: add foundation sqlite schema"
```

### Task 3: Bootstrap, passkeys, invitations, and member recovery

**Requirements:** `FND-001`, local-auth portion of `FND-002`.

**Files:**
- Create: `src/server/modules/identity/{contract,identity-authority,passkeys,invitations,recovery}.ts`
- Modify: `src/shared/contracts/identity.ts`
- Modify: `src/server/db/migrations/0001_foundation.sql`
- Modify: `src/server/db/migrations/0001_foundation.verify.ts`
- Test: `tests/unit/identity/policies.test.ts`
- Test: `tests/integration/identity/local-auth.test.ts`

**Interfaces:**
- Consumes: `Result<T>`, schema version 1, `@simplewebauthn/server` verified registration/authentication results.
- Produces: `IdentityAuthority.bootstrap`, passkey begin/finish/authenticate/revoke, recovery-code generate/redeem, invitation create/inspect/revoke/accept.

- [ ] **Step 1: Write failing one-time and secret lifecycle tests**

```ts
import { expect, test } from "bun:test";
import { createIdentityFixture } from "../../fixtures/identity.ts";

test("bootstrap is one-time and invitations are hash-only single-use", async () => {
  const fixture = createIdentityFixture();
  const first = await fixture.identity.bootstrap(fixture.bootstrapCommand("Ada"));
  expect(first.ok).toBe(true);
  expect((await fixture.identity.bootstrap(fixture.bootstrapCommand("Grace"))).ok).toBe(false);
  const invitation = await fixture.identity.invite(fixture.inviteCommand(first));
  expect(invitation.ok).toBe(true);
  expect(fixture.databaseText()).not.toContain(invitation.ok ? invitation.value.secret : "");
  expect((await fixture.identity.accept(fixture.acceptCommand(invitation))).ok).toBe(true);
  expect((await fixture.identity.accept(fixture.acceptCommand(invitation))).error?.code).toBe("INVITATION_USED");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/unit/identity tests/integration/identity/local-auth.test.ts`

Expected: FAIL because `IdentityAuthority` has no implementation.

- [ ] **Step 3: Implement the complete identity interface and bounded secret hashing**

```ts
// src/server/modules/identity/contract.ts
export interface IdentityAuthority {
  bootstrap(command: BootstrapDeployment): Promise<Result<MemberSession>>;
  beginPasskeyRegistration(command: BeginPasskeyRegistration): Promise<Result<PasskeyChallenge>>;
  finishPasskeyRegistration(command: FinishPasskeyRegistration): Promise<Result<PasskeyCredential>>;
  authenticate(command: AuthenticatePasskey): Promise<Result<MemberSession>>;
  listPasskeys(query: ListPasskeys): Promise<Result<readonly PasskeyCredential[]>>;
  revokePasskey(command: RevokePasskey): Promise<Result<PasskeyRevocation>>;
  generateRecoveryCodes(command: GenerateRecoveryCodes): Promise<Result<RecoveryCodeSet>>;
  redeemRecoveryCode(command: RedeemRecoveryCode): Promise<Result<RecoverySession>>;
  invite(command: CreateInvitation): Promise<Result<TeamInvitation>>;
  exchangeInvitation(command: ExchangeInvitationSecret): Promise<Result<InvitationSession>>;
  inspectInvitation(query: InspectInvitation): Promise<Result<TeamInvitation>>;
  revokeInvitation(command: RevokeInvitation): Promise<Result<TeamInvitation>>;
  accept(command: AcceptInvitationWithVerifiedIdentity): Promise<Result<MemberSession>>;
}
```

The Task 3 implementation is limited to bootstrap, local passkeys, member recovery codes, and invitations. Provider linking, host break-glass recovery, hardened ordinary sessions, role changes, removal, and offboarding are implemented in Task 4. Pre-authentication commands use explicit bounded bootstrap, invitation-session, or recovery-session principals rather than forged Member actors. Invitation acceptance requires a 15-minute, HTTP-only, invitation-specific exchange session plus a verified local identity ceremony; possession of the raw fragment secret or an upstream identity alone is insufficient. WebAuthn challenges are purpose-bound, expiring, single-use records. Secret-producing idempotency records never contain clear bootstrap secrets, invitation tokens, or recovery codes.

```ts
// src/server/modules/identity/recovery.ts
export async function hashOneTimeSecret(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 }, material, 256);
  return new Uint8Array(bits);
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/unit/identity tests/integration/identity/local-auth.test.ts`

Expected: PASS; bootstrap, WebAuthn origin/RP checks, invitation exchange, recovery rotation, and passkey revocation are transactional and auditable.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/identity tests/unit/identity tests/integration/identity tests/fixtures/identity.ts
git commit -m "feat: implement local identity lifecycle"
```

### Task 4: Sessions, CSRF, devices, DPoP, providers, host recovery, and offboarding

**Requirements:** remaining `FND-002`; identity portion of `ORP-15`.

**Files:**
- Create: `src/server/modules/identity/{sessions,csrf,devices,oidc,auth-proxy,provider-links,revocation}.ts`
- Create: `src/server/modules/connectors/{contract,connector-authority,credentials,epochs,scope-policy}.ts`
- Modify: `src/shared/contracts/commands.ts`
- Create: `src/server/adapters/http/middleware/{session,csrf}.ts`
- Create: `src/server/commands/auth-recover.ts`
- Modify: `src/server/db/migrations/0001_foundation.sql`
- Modify: `src/server/db/migrations/0001_foundation.verify.ts`
- Test: `tests/integration/identity/{providers,devices,offboarding}.test.ts`
- Test: `tests/unit/connectors/contract.test.ts`
- Test: `tests/integration/connectors/authority.test.ts`

**Interfaces:**
- Consumes: `IdentityAuthority`, SQLite transaction, `ExecutionAuthority.execute(ApplyRevocation)`.
- Produces: `OidcPort`, `AuthProxyPort`, rotating device sessions, DPoP verification, CSRF
  middleware, encrypted credential store, host-only recovery command, atomic member removal, and the
  Foundation `ConnectorAuthority`/`SourceConnector` contract consumed by GitHub and Outline.

- [ ] **Step 1: Write failing provider and revocation tests**

```ts
import { expect, test } from "bun:test";
import { createIdentityFixture } from "../../fixtures/identity.ts";

test("provider identity never creates membership and offboarding revokes every epoch", async () => {
  const f = createIdentityFixture();
  const linked = await f.identity.linkProvider(f.oidcLink({ issuer: "https://issuer.test", subject: "subject-1", invitationId: f.invitationId }));
  expect(linked.ok).toBe(true);
  expect((await f.identity.linkProvider(f.oidcLink({ issuer: "https://issuer.test", subject: "subject-2" }))).error?.code).toBe("INVITATION_REQUIRED");
  const removed = await f.identity.remove(f.removeCommand(linked));
  expect(removed.ok).toBe(true);
  expect(f.revocations()).toEqual(["MEMBER", "RUNNER", "SESSION", "DEVICE"]);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/integration/identity/providers.test.ts tests/integration/identity/devices.test.ts tests/integration/identity/offboarding.test.ts`

Expected: FAIL because provider, device, and revocation modules do not exist.

- [ ] **Step 3: Implement provider ports, CSRF, DPoP, and one offboarding transaction**

```ts
import { createHash, timingSafeEqual } from "node:crypto";

export interface OidcPort {
  verify(input: Readonly<{ transaction: StoredOidcTransaction; provider: StoredOidcProvider; authorizationCode: string; returnedState: string }>): Promise<Result<Readonly<{ issuer: string; subject: string }>>>;
}
export interface AuthProxyPort {
  verify(input: Readonly<{ provider: StoredAuthProxyProvider; assertion: string; provenance: VerifiedProxyProvenance }>): Promise<Result<Readonly<{ issuer: string; subject: string }>>>;
}
export function verifyCsrf(sessionCsrfHash: Uint8Array, headerToken: string, request: SameOriginMutation): boolean {
  const left = sessionCsrfHash;
  const right = createHash("sha256").update(headerToken, "utf8").digest();
  return left.length === right.length && timingSafeEqual(left, right);
}
export type DeviceAccess = Readonly<{ memberId: string; deviceId: string; senderKeyThumbprint: string; expiresAt: number }>;
```

```ts
export type Observed<T> = Readonly<{
  value: T;
  reference: ContextReference;
  sourceRevision: string;
  comparableDigest: Sha256;
  projectionRevision: number;
  observedAt: number;
  sourceUpdatedAt?: number;
  freshness: "FRESH" | "STALE" | "UNAVAILABLE" | "REDACTED";
  provenance: Readonly<{ projectId: ProjectId; connectorId: ConnectorId; connectorEpoch: number; kind: "WEBHOOK" | "RECONCILIATION" | "MUTATION_CONFIRMATION"; providerActorId?: string }>;
}>;
export type ExactRevisionMutation<T> = Readonly<{
  projectId: ProjectId;
  connectorId: ConnectorId;
  connectorEpoch: number;
  idempotencyKey: string;
  expectedRevision: string;
  expectedComparableDigest: Sha256;
  actionDigest: Sha256;
  mutation: T;
}>;
export interface SourceConnector<R, P, M> {
  inspect(scope: ConnectorScope, reference: R): Promise<Result<Observed<P>>>;
  mutate(authorization: ConnectorOperationAuthorization, command: ExactRevisionMutation<M>): Promise<Result<Observed<P>>>;
  reconcile(scope: ConnectorScope, event: ReconciliationEvent<R>): Promise<Result<Observed<P>>>;
}
```

`ConnectorAuthority` owns connector scope, epoch, human authorization, attempt-operation
authorization consumption, idempotency, audit, and projection application. An ordinary authenticated
ACTIVE Member uses a closed human connector command after current membership/scope/epoch checks; it
does not need an `AuthoritySession`. An attempt-originated write first consumes the exact
`ExecutionAuthority` operation authorization, then enters the same connector command. Provider ports
receive an opaque short-lived `ConnectorOperationAuthorization`; they never decide actor authority,
persist idempotency/audit/projections, or mutate epochs.

Foundation also owns a run-independent source reconciliation command. It binds exact project,
connector, epoch, source reference, provider revision/comparable digest, freshness, provenance, and
idempotency key; it does not forge a run ID or reuse run-scoped `RECONCILE_OBSERVATION`. Webhook,
periodic reconciliation, and mutation confirmation converge through this one revision-guarded
projection application path.

Every connector schema is strict and bounded. `Observed<T>` separates source revision/provider time,
comparable-field digest, local projection revision, server observation time, freshness, scope, and
provenance. `ExactRevisionMutation<T>` carries expected revision plus prior comparable digest and one
outer action digest. Connector scopes are explicit project/connector/epoch allowlists. Same
idempotency key and canonical input replays; changed input conflicts. No connector contract admits
raw provider payloads, bodies, credentials, URLs/GraphQL documents, or provider error text.

Reconcile the shared sensitive-operation vocabulary now so later phases cannot define a second set.
The closed GitHub kinds are `CREATE_ISSUE`, `EDIT_ISSUE`, `ADD_COMMENT`, `SET_LABELS`,
`SET_ASSIGNEES`, `SET_MILESTONE`, `SET_ISSUE_STATE`, `CREATE_MILESTONE`, `EDIT_MILESTONE`,
`ADD_PROJECT_ITEM`, `REMOVE_PROJECT_ITEM`, `SET_PROJECT_FIELD`, and `MOVE_PROJECT_ITEM`. The closed
Outline kinds are `CREATE_DOCUMENT_AS_MEMBER`, `EDIT_DOCUMENT_AS_MEMBER`, `EDIT_DOCUMENT_AS_BOT`,
`APPLY_PROPOSAL_AS_MEMBER`, `PROMOTE_WORKING_DOCUMENT`, and `ARCHIVE_WORKING_DOCUMENT`. One outer
authorization envelope owns connector/project/epoch, expected revision/prior digest, and action
digest; nested provider mutations do not duplicate authority fields.

```ts
// src/server/modules/identity/revocation.ts
export function removeMemberTransaction(db: Database, command: RemoveMember): Result<MemberRemoval> {
  return inImmediateTransaction(db, () => {
    assertNotLastOwner(db, command.memberId);
    const revision = revokeMembershipAndCredentials(db, command);
    persistAuthorityRevocationOutbox(db, command, revision);
    return ok({ memberId: command.memberId, authorityEpoch: revision.authorityEpoch, disposition: "REVOKED" });
  });
}
```

Expected issuer, audience, redirect binding, state, nonce, and proxy trust provenance are loaded or minted by server-owned configuration and request adapters; public callers never supply their own expected values or an `originTrusted` boolean. The CSRF proof is a separate session-bound secret whose bearer is never the HTTP-only application cookie, and the middleware also enforces configured origin, mutation method, and content type. Offboarding commits a durable revocation outbox intent inside SQLite and invokes `ExecutionAuthority` only after commit; no asynchronous provider or authority call runs inside `BEGIN IMMEDIATE`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/unit/connectors tests/integration/connectors tests/integration/identity && bun test tests/drills/offboarding-active-run.test.ts`

Expected: PASS; issuer/audience/signature/state/nonce, trusted proxy origin, CSRF, refresh rotation, sender binding, last-owner races, container recovery, and offboarding all fail closed.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/commands.ts src/server/db/migrations/0001_foundation.sql src/server/db/migrations/0001_foundation.verify.ts src/server/modules/identity src/server/modules/connectors src/server/adapters/http/middleware src/server/commands tests/unit/connectors tests/integration/connectors tests/integration/identity tests/drills/offboarding-active-run.test.ts
git commit -m "feat: secure provider and device identity"
```

### Task 5: Project registry, repository discovery, and local global database

**Requirements:** persistence/discovery portion of `FND-003`, `ORP-09`; `FND-003` remains `IN_PROGRESS` until Task 13 proves web/CLI parity.

**Files:**
- Create: `src/server/modules/projects/{contract,project-registry}.ts`
- Create: `src/runner/repository/{config,discovery,global-registry}.ts`
- Create: `src/cli/commands/{init,list,projects,status}.ts`
- Modify: `src/server/db/migrations/0001_foundation.sql`
- Modify: `src/server/db/migrations/0001_foundation.verify.ts`
- Test: `tests/unit/projects/discovery.test.ts`
- Test: `tests/integration/{projects,cli-projects}.test.ts`

**Interfaces:**
- Consumes: `ProjectRegistry`, project schemas, member/device actor.
- Produces: `.collab/config.toml` parser, upward discovery, `~/.collab/global.db`, path-local project resolution.

- [ ] **Step 1: Write failing discovery tests**

```ts
import { expect, test } from "bun:test";
import { parseProjectConfig } from "../../../src/runner/repository/config.ts";

test("accepts the exact project keys and rejects traversal", () => {
  expect(parseProjectConfig('project_id="proj_1"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="main"\n')).toEqual({ projectId: "proj_1", teamId: "team_1", serverUrl: "https://collab.test", baseBranch: "main" });
  expect(() => parseProjectConfig('project_id="../escape"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="main"\n')).toThrow("PROJECT_CONFIG_INVALID");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/unit/projects tests/integration/projects.test.ts tests/integration/cli-projects.test.ts`

Expected: FAIL because project discovery modules do not exist.

- [ ] **Step 3: Implement exact config and local registry schemas**

```ts
export const ProjectConfigSchema = z.object({
  project_id: IdentifierSchema,
  team_id: IdentifierSchema,
  server_url: CanonicalServerOriginSchema,
  base_branch: GitRefSchema,
}).strict();
export interface ProjectRegistry {
  register(command: RegisterProject): Promise<Result<Project>>;
  inspect(query: InspectProject): Promise<Result<Project>>;
  list(query: ListProjects): Promise<Result<readonly Project[]>>;
}
```

`CanonicalServerOriginSchema` parses URL components and accepts only an HTTPS origin or exact-host `http://localhost[:port]`, with no credentials, path, query, or fragment; it returns one no-trailing-slash canonical origin. `collab init` links an existing Project and never creates one. The versioned local SQLite registry uses `(server_origin, project_id)` identity, a unique canonical preferred path, explicit moved-checkout replacement, and corruption failure. Upward discovery bounds file size, rejects symlink escapes, and keeps every absolute path inside runner/CLI adapters. `projects.name` receives the same 120-character database bound as its shared schema.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/unit/projects tests/integration/projects.test.ts tests/integration/cli-projects.test.ts`

Expected: PASS; inside/outside repository resolution returns the same project ID and no absolute path reaches the server fixture.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/projects src/runner/repository src/cli/commands tests/unit/projects tests/integration/projects.test.ts tests/integration/cli-projects.test.ts
git commit -m "feat: add project discovery and registry"
```

### Task 6: Runner registry, pairing, mappings, and Team Dispatch Exposures

**Requirements:** registry portion of `FND-004` and `FND-015`, runner prerequisite for `FND-007`; surface and authority proofs remain `IN_PROGRESS` until Tasks 10 and 13.

**Files:**
- Create: `src/server/db/migrations/0002_runners.sql`
- Create: `src/server/db/migrations/0002_runners.verify.ts`
- Create: `src/server/modules/runners/{contract,runner-registry,exposures}.ts`
- Modify: `src/shared/contracts/runners.ts`
- Modify: `src/server/db/{migrate}.ts`
- Test: `tests/integration/runners/registry.test.ts`

**Interfaces:**
- Consumes: identity/device credentials and project IDs.
- Produces: `RunnerRegistry`, pairing, immutable ownership, mappings, policy revisions, heartbeat leases, exact acknowledged exposures, revocation.

- [ ] **Step 1: Write failing runner ownership tests**

```ts
test("runner registry preserves ownership and returns stale exposure facts", async () => {
  const f = createRunnerFixture();
  const runner = await f.pair("member_a", "OWNER_ONLY");
  expect((await f.replacePolicy(runner, "member_b", { audience: "TEAM" })).error?.code).toBe("RUNNER_OWNER_REQUIRED");
  const exposure = await f.expose(runner, { mappingRevision: 1, profileVersionId: "profile_1", acknowledgementVersion: 1 });
  expect((await f.inspectEligibility(runner, exposure)).value?.disposition).toBe("CURRENT");
  await f.replacePolicy(runner, 2);
  expect((await f.inspectEligibility(runner, exposure)).value?.disposition).toBe("STALE");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/integration/runners/registry.test.ts`

Expected: FAIL because runner schema and registry are missing.

- [ ] **Step 3: Add runner persistence and registry interface**

Migration 0002 creates strict, revisioned `runners`, `runner_credentials`, `runner_pairings`, `runner_mappings`, `safe_profile_versions`, `runner_exposure_acknowledgements`, `runner_exposures`, and `runner_revocation_outbox` tables. It enforces immutable owner and acknowledgement rows, hash-only one-time pairing, key-thumbprint-bound runner credentials, `OWNER_ONLY` default, positive runner/policy epochs, bounded concurrency, active mapping uniqueness, exact mapping/profile/policy/security-digest exposure tuples, and nonnegative lifecycle times. It stores server-received heartbeat time but no caller-supplied `ONLINE` status, local path, command, environment, credential cleartext, or connector state.

```ts
export interface RunnerRegistry {
  beginPairing(command: BeginRunnerPairing): Promise<Result<RunnerPairingChallenge>>;
  confirmPairing(command: ConfirmRunnerPairing): Promise<Result<ConfirmedRunnerPairing>>;
  consumePairing(command: ConsumeRunnerPairing): Promise<Result<RunnerCredentialEnvelope>>;
  registerMapping(command: RegisterRunnerMapping): Promise<Result<RunnerMapping>>;
  advertiseProfile(command: AdvertiseSafeProfileVersion): Promise<Result<SafeProfileVersion>>;
  acknowledgeExposure(command: AcknowledgeTeamExposure): Promise<Result<ExposureAcknowledgement>>;
  createExposure(command: CreateTeamExposure): Promise<Result<TeamDispatchExposure>>;
  replacePolicy(command: ReplaceRunnerPolicy): Promise<Result<RegisteredRunner>>;
  heartbeat(command: RunnerHeartbeat): Promise<Result<RunnerLeaseView>>;
  revoke(command: RevokeRunner): Promise<Result<RunnerRevocation>>;
  inspectEligibility(query: InspectRunnerEligibility): Promise<Result<RunnerEligibilityFacts>>;
}
```

Pairing is layered on a current DPoP-bound CLI device session but returns a distinct runner credential and immutable runner owner; a device credential never authenticates WSS as a runner. Registry methods expose exact facts and mutations, not dispatch authorization: `ExecutionAuthority` alone decides whether a dispatcher may launch. Persistence includes runner credentials/key thumbprints, safe profile advertisements, bounded concurrency, append-only acknowledgement content digests, exact exposure tuple revisions, and durable revocation intents. Status is derived from server-received heartbeat time rather than trusted client status. Adding migration 0002 must prove empty-to-v2 and v1-to-v2 upgrades, idempotency, history integrity, and migration rollback. Source-free mappings remain connector-neutral and contain opaque local mapping identifiers only.

- [ ] **Step 4: Verify GREEN**

Run: `bun test src/server/db/migrations/0002_runners.verify.ts tests/integration/runners/registry.test.ts`

Expected: PASS; pairing replay, stale credentials, immutable ownership, exact exposure facts, acknowledgement refresh, and revocation are enforced without duplicating dispatch policy.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/migrations/0002_runners.sql src/server/db/migrations/0002_runners.verify.ts src/server/modules/runners tests/integration/runners
git commit -m "feat: add secure runner registry"
```

### Task 7: Typed outbound WSS runner data plane

**Requirements:** transport portion of `FND-012`, `FND-004`, and `FND-007`; durable storage/process proofs remain `IN_PROGRESS` until Tasks 9, 10, and 14.

**Files:**
- Create: `src/server/adapters/wss/{protocol,runner-channel,revocations}.ts`
- Create: `src/runner/transport/wss-client.ts`
- Modify: `src/shared/contracts/protocol.ts`
- Create: `tests/protocol/runner-data-plane.test.ts`
- Create: `tests/fixtures/runner-channel.ts`

**Interfaces:**
- Consumes: shared runner frame schemas and `ExecutionAuthority.execute`.
- Produces: private `RunnerControlPort`, `BunWssRunnerControlAdapter`, `InMemoryRunnerControlAdapter`.

- [ ] **Step 1: Write failing frame and replay tests**

```ts
test("rejects commands, oversized frames, and duplicate messages", async () => {
  const channel = createInMemoryRunnerChannel({ maximumFrameBytes: 65_536 });
  expect(await channel.receiveText('{"kind":"SHELL","command":"rm -rf /"}')).toEqual({ accepted: false, code: "FRAME_KIND_DENIED" });
  const wire = encodeRunnerFrame(validFrame({ messageId: "msg_1", sequence: 1 }));
  expect(await channel.receiveText(wire)).toEqual({ accepted: true });
  expect(await channel.receiveText(wire)).toEqual({ accepted: false, code: "FRAME_REPLAY" });
  const oversized = wire.replace("{", `{${" ".repeat(65_537)}`);
  expect(await channel.receiveText(oversized)).toEqual({ accepted: false, code: "FRAME_TOO_LARGE" });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/protocol/runner-data-plane.test.ts`

Expected: FAIL because runner-channel fixtures and adapters are missing.

- [ ] **Step 3: Implement the closed port and envelope**

```ts
export interface RunnerControlPort {
  dispatchCommitted(outboxIds: readonly string[]): Promise<Result<readonly SemanticDeliveryReceipt[]>>;
  closeStaleConnections(revocation: CommittedRunnerConnectionRevocation): Promise<Result<ConnectionCloseReceipt>>;
}
```

The data plane has authenticated upgrade, `CLIENT_HELLO`/`SERVER_WELCOME` range negotiation, one current connection fence per runner, and separate strict direction-specific envelopes. Each origin assigns a message ID plus monotonically increasing per-connection sequence; actor/runner/epoch come from the authenticated connection, and durable semantic effects retain command/event idempotency across reconnect. Raw UTF-8 bytes are bounded before JSON parsing, binary and compressed application frames are rejected, and time/order/rate/assignment/backpressure checks precede `ExecutionAuthority.execute`. The committed outbox contains only safe permit claims/hash; the signed short-lived capability is reconstructed after commit. Socket send, semantic acknowledgement, and process start remain separate facts. Revocation transport accepts only a committed typed disposition and never infers process termination from a closed socket.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/protocol/runner-data-plane.test.ts`

Expected: PASS; assignment, audience, replay, expiry, size, rate, heartbeat, idle, backpressure, and allowlisted-operation cases are deterministic.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/protocol.ts src/server/adapters/wss src/runner/transport/wss-client.ts tests/protocol/runner-data-plane.test.ts tests/fixtures/runner-channel.ts
git commit -m "feat: add typed runner data plane"
```

### Task 8: Runner supervisor, Claude/Codex, Native/Orca, and diagnostics

**Requirements:** adapter/supervisor portion of `FND-005` and `FND-018`; authority/worktree/restart drills remain `IN_PROGRESS` until Tasks 10, 12, and 14.

**Files:**
- Create: `src/runner/{daemon,supervisor,local-diagnostics}.ts`
- Create: `src/runner/{profiles,process-state,environment}.ts`
- Create: `src/runner/credentials/os-store.ts`
- Create: `src/runner/db/{connection,migrate}.ts`
- Create: `src/runner/db/migrations/0001_profiles_processes.sql`
- Create: `src/runner/adapters/runtime/{contract,claude,codex}.ts`
- Create: `src/runner/adapters/host/{contract,native,orca}.ts`
- Create: `src/runner/adapters/enforcement/{contract,trusted-host}.ts`
- Test: `tests/runner/conformance/{runtime,host}.test.ts`
- Test: `tests/runner/local-diagnostics.test.ts`
- Modify: `src/shared/contracts/runs.ts`

**Interfaces:**
- Consumes: typed permits, generic execution selection, local profile registry.
- Produces: `ExecutionAdapter.prepare`, `ExecutionHost.start/cancel/inspect/attach`, `RepositoryEnforcementAdapter`, `RunnerSupervisor`, encrypted local-tail store.

- [ ] **Step 1: Write failing shared conformance tests**

```ts
for (const adapter of [claudeFixture(), codexFixture()]) {
  test(`${adapter.name} prepares argv without starting a process`, async () => {
    const prepared = await adapter.prepare(headlessRequest());
    expect(prepared.invocation.argv.length).toBeGreaterThan(0);
    expect(prepared).not.toHaveProperty("environment");
    expect(adapter.startedProcesses()).toBe(0);
  });
}
for (const host of [nativeFixture(), orcaFixture()]) {
  for (const interaction of ["HEADLESS", "INTERACTIVE"] as const) {
    test(`${host.name} ${interaction} starts only prepared execution`, async () => {
      expect((await host.start(preparedExecution(interaction))).interaction).toBe(interaction);
    });
  }
}
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/runner/conformance tests/runner/local-diagnostics.test.ts`

Expected: FAIL because runtime, host, enforcement, and diagnostic implementations do not exist.

- [ ] **Step 3: Implement the runner adapter contracts**

```ts
export interface ExecutionAdapter {
  readonly runtime: "CLAUDE" | "CODEX";
  prepare(request: PreparedExecutionRequest): Promise<Result<PreparedExecution>>;
  normalize(event: RuntimeOutputEvent): Result<NormalizedRuntimeEvent>;
}
export interface ExecutionHost {
  readonly host: "NATIVE" | "ORCA";
  start(execution: SupervisorLaunch): Promise<Result<HostProcess>>;
  cancel(process: HostProcess): Promise<Result<HostDisposition>>;
  inspect(process: HostProcess): Promise<Result<HostObservation>>;
  attach(process: HostProcess): Promise<Result<LocalAttachment>>;
}
export interface LocalProfileRegistry {
  resolve(profileVersionId: string, expectedFingerprint: string): Result<LocalProfileVersion>;
}
export interface LocalProcessRegistry {
  reserve(attemptId: string, assignmentDigest: string): Result<ProcessStartReservation>;
  recordStarted(reservation: ProcessStartReservation, identity: OpaqueHostProcessIdentity): Result<void>;
  inspect(attemptId: string): Result<LocalProcessState>;
}
export interface WorktreePort {
  resolveRunWorktree(runId: string, worktreeKey: string): Promise<Result<OpaqueWorktreeHandle>>;
}
export const trustedHostEnforcement: RepositoryEnforcementAdapter = {
  assurance: "ADVISORY",
  activate: activateAdvisorySession,
  inspect: inspectAdvisorySession,
  revoke: revokeAdvisorySession,
};
```

The runtime adapter returns a host-neutral invocation and never an environment. The supervisor resolves the run-owned worktree through `WorktreePort`, builds a minimal allowlisted environment from runner-local configuration/OS-credential references, activates assurance, consumes the permit immediately before start, and supplies the resulting `SupervisorLaunch` to Native or Orca. The versioned `~/.collab/runner.db` owns profile and opaque process reconciliation state but no shared lifecycle or raw output. Duplicate assignment digests reconcile; changed reuse fails. Trusted Native/Orca always report `ADVISORY`, and every `ENFORCED` request starts zero processes. Headless output uses split-safe redaction and bounded live chunks; interactive bytes have no shared code path. Diagnostics use local AEAD, owner reauthentication, 2MiB/24h caps, and only the metadata allowlist defined by the Product Spec.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/runner/conformance tests/runner/local-diagnostics.test.ts`

Expected: PASS for both runtimes and all Native/Orca by HEADLESS/INTERACTIVE combinations; `ENFORCED` is rejected and diagnostic bytes remain encrypted, owner-only, under 2MiB, and under 24h.

- [ ] **Step 5: Commit**

```bash
git add src/runner tests/runner/conformance tests/runner/local-diagnostics.test.ts
git commit -m "feat: add trusted runner adapters"
```

### Task 9: Run/attempt schema, minimal Coordination Records, and authority contract

**Requirements:** persistence prerequisite for `FND-006` through `FND-011`, `FND-016`, and `FND-017`; no behavioral requirement is marked complete by schema alone.

**Files:**
- Create: `src/server/db/migrations/0003_runs_authority.sql`
- Create: `src/server/db/migrations/0003_runs_authority.verify.ts`
- Create: `src/server/modules/coordination-records/{canonical-key,registry,source-links}.ts`
- Create: `src/server/modules/execution-authority/{contract,persistence}.ts`
- Modify: `src/shared/contracts/{runs,execution-authority}.ts`
- Test: `tests/integration/runs/source-free-creation.test.ts`

**Interfaces:**
- Consumes: shared `ExecutionAuthority` contract, runner/project revisions, SQLite transaction.
- Produces: schema version 3, minimal source-free record, canonical source-reference key, three-entry authority implementation seam.

- [ ] **Step 1: Write failing atomic source-free creation test**

```ts
test("LAUNCH_RUN atomically creates record, run, attempt, permit, audit, and outbox", async () => {
  const f = createAuthorityFixture();
  f.failCommitAfter("authority_snapshots");
  const failed = await f.launchPersistence.create(f.launchSourceFree());
  expect(failed.ok).toBe(false);
  expect(f.counts()).toEqual({ records: 0, runs: 0, attempts: 0, permits: 0, audits: 0, outbox: 0 });
  f.clearFailure();
  expect((await f.launchPersistence.create(f.launchSourceFree())).ok).toBe(true);
  expect(f.counts()).toEqual({ records: 1, runs: 1, attempts: 1, permits: 1, audits: 1, outbox: 1 });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/integration/runs/source-free-creation.test.ts`

Expected: FAIL because schema version 3 and authority implementation are missing.

- [ ] **Step 3: Add the authoritative schema**

Migration 0003 is the complete durable execution/configuration foundation for Tasks 10–12. It creates strict tables for:

- Coordination Records and canonical source references keyed by `(project_id, connector_id, source_item_id)` with project-consistent foreign keys;
- Agent Runs, predecessor/follow-up edges, run-owned opaque worktree identity, immutable effective configuration, dispatcher, bounds, waiting/terminal reasons, and exact repository/branch provenance;
- Execution Attempts with ordinals, exact runner/mapping/profile/exposure/policy/host/mode selections, acknowledgement/start/terminal facts, signals, and one active-attempt constraint;
- append-only run and attempt events, typed run results/evidence links, immutable checkpoints plus append-only human responses/decisions, and closed versioned evidence payloads with byte bounds/digests;
- dedicated mutation reservations, mutation overrides/collisions, and branch claims rather than a nullable guard column;
- normalized immutable authority snapshots, hash-only single-use permits, fenced authority sessions, distinct mutation leases, and exact revocation/release/expiry bindings;
- safe WSS delivery intents that reference permit claims/hash without clear signed capabilities, prompts, output, paths, or arbitrary message JSON;
- hardened actor-kind/command-kind idempotency with fixed canonical input hashes and bounded safe result projections;
- versioned Personal Run Presets, Context Recipes, immutable Effective Run Configurations, usage observations/coverage, Published Git References, and Retained Local Work references needed by Tasks 11–12.

Every mutable revision, epoch, ordinal, and fence is positive; lifecycle time relationships and UPPERCASE enums are constrained. Historical rows do not cascade away. Named security/query indexes participate in claimed-schema integrity. `migrate` proves empty-to-v3, v1-to-v3, and v2-to-v3 under one serialized transaction and rejects missing/gapped/corrupt state. The private launch persistence seam atomically writes the record, run, first attempt, snapshot, permit state, mutation reservation/lease when required, audit, idempotency projection, and safe WSS intent; signing and transport happen only after commit. `ExecutionAuthority` behavior remains Task 10.

- [ ] **Step 4: Verify GREEN**

Run: `bun test src/server/db/migrations/0003_runs_authority.verify.ts tests/integration/runs/source-free-creation.test.ts`

Expected: PASS; empty `sourceRefs` creates one minimal Coordination Record and complete launch graph, every injected failure rolls the whole transaction back, upgrades preserve v1/v2 data, and no clear capability or prohibited content reaches storage.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/migrations/0003_runs_authority.sql src/server/db/migrations/0003_runs_authority.verify.ts src/server/db/migrate.ts src/shared/contracts/runs.ts src/shared/contracts/execution-authority.ts src/server/modules/coordination-records src/server/modules/execution-authority/contract.ts src/server/modules/execution-authority/persistence.ts tests/integration/runs/source-free-creation.test.ts
git commit -m "feat: add coordination and run schema"
```

### Task 10: Deep ExecutionAuthority lifecycle, permits, sessions, evidence, and revocation

**Requirements:** `FND-007`, authority/lifecycle portion of `FND-008` and `FND-009`, `ORP-15`; durable reconnect/lost fault proof remains `IN_PROGRESS` until Task 14.

**Files:**
- Create: `src/server/modules/execution-authority/{execution-authority,policy,fencing,revocation}.ts`
- Create: `src/server/modules/runs/{lifecycle,checkpoints,evidence,results}.ts`
- Modify: `src/shared/contracts/{commands,runs,execution-authority}.ts`
- Test: `tests/unit/{runs,execution-authority}/`
- Test: `tests/integration/{runs,execution-authority}/`

**Interfaces:**
- Consumes: `ExecutionAuthority`, schema version 3, `RunnerControlPort`, strict external authority-fact ports.
- Produces: all closed `CollabCommand` decisions and `CoordinationQuery` views through three public entry points.

- [ ] **Step 1: Write failing transition and replay tests**

```ts
test("lost attempt waits and resume creates a new immutable attempt", async () => {
  const f = createAuthorityFixture();
  const launched = await f.launch();
  await f.reconcileLost(launched, { kind: "LOST", observedAt: f.clock.now() });
  expect((await f.inspectRun(launched)).value).toMatchObject({ state: "WAITING", attempts: [{ state: "LOST" }] });
  await f.authority.execute(f.resume(launched));
  expect((await f.inspectRun(launched)).value).toMatchObject({ state: "RUNNING", attempts: [{ state: "LOST" }, { state: "PENDING" }] });
});

test("permit replay and stale fence never authorize an operation", async () => {
  const f = createAuthorityFixture();
  const permit = await f.issuePermit();
  const session = await f.consume(permit);
  expect((await f.consume(permit)).error?.code).toBe("PERMIT_REPLAYED");
  await f.renew(session);
  expect((await f.authorize(session, { fence: 1, operation: { kind: "PUBLISH_GIT_REFERENCE", expectedHead: "0123456789abcdef0123456789abcdef01234567" } })).error?.code).toBe("SESSION_FENCE_STALE");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/unit/runs tests/unit/execution-authority tests/integration/runs tests/integration/execution-authority`

Expected: FAIL because lifecycle reducers and authority command implementation are missing.

- [ ] **Step 3: Implement command ordering and stable failures**

```ts
export function createExecutionAuthority(deps: AuthorityDependencies): ExecutionAuthority {
  return {
    preview: (request) => previewAuthority(deps, request),
    execute: async (command) => {
      const externalFacts = await deps.authorityFacts.refresh(requiredFacts(command));
      if (!externalFacts.ok) return err("AUTHORITY_FACT_UNAVAILABLE", "Required authority facts are unavailable.", "REFRESH");
      const committed = inImmediateTransaction(deps.db, () => {
        const replay = findIdempotentResult(deps.db, command);
        if (replay.kind === "MATCH") return replay;
        if (replay.kind === "CONFLICT") return idempotencyConflict();
        return decideAndPersist(deps, command, recheckLocalFacts(deps.db, externalFacts.value));
      });
      if (committed.outboxIds.length > 0) {
        const wake = deps.deliveryScheduler.notifyCommitted(committed.outboxIds);
        if (!wake.ok) deps.telemetry.recordDeliveryPending(committed.outboxIds, wake.error.code);
      }
      return committed.result;
    },
    query: (query) => queryCoordination(deps.db, query),
  };
}
```

Commands use strict runtime schemas and command-specific actor rules. `AUTHORIZE_ATTEMPT` returns an explicit `AUTHORIZED`, `WAITING`, or `DENIED` decision so a pre-creation denial creates no Attempt or budget use. Manual mutation-guard override is a Member-only closed command carrying reason/collision revisions; schedulers and workflows cannot override. Cancellation derives the active-attempt disposition from current state rather than trusting caller input. Results and checkpoints contain typed reason/action and complete recovery facts; process exit includes signal/correlation data. Operation authorizations are short-lived, single-use, exact operation/resource-digest records bound to session fence and consumed immediately before the action. Member/runner/system revocations have distinct authenticated actors and monotonic source epochs. Permit signing/verifying is injected, clear tokens are never persisted, session and mutation-lease fences are separate, and every external fact is refreshed outside then locally rechecked inside the transaction.

```ts
export function transitionAttempt(current: ExecutionAttemptState, event: AttemptEvent): Result<ExecutionAttemptState> {
  const next = ATTEMPT_TRANSITIONS[current]?.[event.kind];
  return next ? ok(next) : err("ATTEMPT_TRANSITION_INVALID", "The attempt event is invalid for its current state.", "REFRESH");
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/unit/runs tests/unit/execution-authority tests/integration/runs tests/integration/execution-authority`

Expected: PASS for immutable terminal states, attempt budget, deadlines, idempotency, exact revisions, permit replay/expiry, monotonic fences, assurance, cancellation, checkpoints, bounded evidence, results, revocation, and query projections.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/commands.ts src/shared/contracts/runs.ts src/shared/contracts/execution-authority.ts src/server/modules/execution-authority src/server/modules/runs tests/unit/runs tests/unit/execution-authority tests/integration/runs tests/integration/execution-authority
git commit -m "feat: implement execution authority"
```

### Task 11: Presets, Context Recipes, and honest usage telemetry

**Requirements:** `FND-006`, `FND-016`, `FND-017`; `ORP-04`, `ORP-05`.

**Files:**
- Create: `src/server/modules/presets/{personal-run-presets,configuration-resolver}.ts`
- Create: `src/server/modules/context/context-recipes.ts`
- Create: `src/server/modules/telemetry/usage.ts`
- Modify: `src/shared/contracts/{presets,context,telemetry}.ts`
- Test: `tests/unit/configuration/{presets,context,telemetry}.test.ts`
- Test: `tests/integration/configuration/snapshots.test.ts`

**Interfaces:**
- Consumes: run command schemas, source references, evidence rules.
- Produces: immutable `EffectiveRunConfiguration`, bounded `BootstrapEnvelope`, partial `UsageCoverage`.

- [ ] **Step 1: Write failing snapshot and partial-coverage tests**

```ts
test("preset edits do not rewrite launch snapshots", async () => {
  const f = createConfigurationFixture();
  const preset = await f.savePreset({ runtime: "CLAUDE", maxAttempts: 1 });
  const run = await f.launch(preset);
  await f.editPreset(preset, { runtime: "CODEX", maxAttempts: 2 });
  expect(await f.runConfiguration(run)).toMatchObject({ runtime: "CLAUDE", maxAttempts: 1, presetVersion: 1 });
});

test("unknown usage remains unknown", () => {
  expect(aggregateUsage([{ units: 10 }, { units: "UNKNOWN" }])).toEqual({ knownUnits: 10, knownAttempts: 1, totalAttempts: 2, coverage: "PARTIAL" });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/unit/configuration tests/integration/configuration/snapshots.test.ts`

Expected: FAIL because configuration modules do not exist.

- [ ] **Step 3: Implement bounded configuration values**

```ts
export type ContextRecipeVersion = Readonly<{
  id: string;
  version: number;
  projectId: string;
  perCategoryLimits: Readonly<Record<ContextCategory, number>>;
  maximumReferences: number;
  maximumPreviewBytes: number;
  freshnessSeconds: number;
  predecessorPolicy: PredecessorContextPolicy;
}>;
export function assembleBootstrapEnvelope(
  recipe: ContextRecipeVersion,
  authorizedCandidates: readonly AuthorizedContextCandidate[],
  now: number,
): Result<BootstrapEnvelope>;
export function aggregateUsage(
  eligibleAttempts: readonly AttemptUsageEligibility[],
  observations: readonly UsageObservation[],
): readonly UsageCoverageGroup[];
```

Personal Run Presets are member-owned logical records with immutable versions, optional Project scope/default, expected-version edits, and archive state. Resolution snapshots the full safe effective configuration and canonical digest atomically with the Run: Team template/core and typed variables, labelled personal addendum, per-run goal/input, exact recipe/envelope provenance, runner/mapping/profile/exposure/acknowledgement/policy facts, grants/gates, bounds, and visible overrides remain separate rather than a flattened prompt. Every later layer may narrow but never widen mode, assurance, source/grant scope, gates, or bounds; stale bindings fail without substitution.

Context Recipes are immutable Project-owned versions. They intersect already-authorized candidates, never grant access, apply deterministic category and total limits, deduplicate with stable tie-breaks, report `FRESH`, `STALE`, `UNAVAILABLE`, and `FORBIDDEN` plus omission reasons, and bound previews in UTF-8 bytes without splitting code points. Stored envelopes contain safe identifiers/revisions/provenance and bounded authored previews only—no fetched bodies, diffs, logs, transcripts, absolute paths, or broad history.

Usage persistence separates eligible attempts from append-only deduplicated observations. Aggregation groups compatible runtime/provider, reported model, and metric category; it never adds `TOTAL` to components or combines incompatible dimensions. Structured zero is known, unavailable is `UNKNOWN`, coverage counts eligible attempts, declared model remains configuration provenance, and no cost/currency/pricing field exists.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/unit/configuration tests/integration/configuration/snapshots.test.ts`

Expected: PASS; future edits do not alter history, recipes grant no authority, previews stay bounded, and telemetry never invents zero, cost, or model proof.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/presets.ts src/shared/contracts/context.ts src/shared/contracts/telemetry.ts src/server/modules/presets src/server/modules/context src/server/modules/telemetry tests/unit/configuration tests/integration/configuration
git commit -m "feat: add immutable run configuration"
```

### Task 12: Worktree ownership, publication, and safe cleanup

**Requirements:** `FND-010`, `FND-011`.

**Files:**
- Create: `src/runner/repository/{worktrees,publish,cleanup}.ts`
- Modify: `src/shared/contracts/{runs,commands}.ts`
- Modify: `src/runner/process-state.ts`
- Test: `tests/runner/worktrees.test.ts`

**Interfaces:**
- Consumes: run ID, local project mapping, exact base revision, runner owner actor.
- Produces: `WorktreeManager.createOrReuse`, verified `PublishedGitReference`, `CleanupDisposition`.

- [ ] **Step 1: Write failing temporary-repository tests**

```ts
test("one run reuses one worktree and dirty work is retained", async () => {
  using f = await createGitFixture();
  const first = await f.manager.createOrReuse(f.request("run_1"));
  const resumed = await f.manager.createOrReuse(f.request("run_1"));
  const separate = await f.manager.createOrReuse(f.request("run_2"));
  expect(resumed.worktreeKey).toBe(first.worktreeKey);
  expect(separate.worktreeKey).not.toBe(first.worktreeKey);
  await f.writeUntracked(first, "retained.txt");
  expect(await f.manager.cleanup(first, f.owner())).toEqual({ kind: "RETAINED_LOCAL_WORK", reason: "UNTRACKED_FILES" });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/runner/worktrees.test.ts`

Expected: FAIL because the worktree manager does not exist.

- [ ] **Step 3: Implement opaque worktree identity and cleanup gate**

```ts
export interface WorktreeManager {
  createOrReuse(request: WorktreeRequest): Promise<Result<WorktreeHandle>>;
  publish(handle: WorktreeHandle, authorization: AttemptPublishAuthorization | RetainedWorkPublishAuthorization): Promise<Result<PublishedGitReference>>;
  cleanup(handle: WorktreeHandle, authorization: CommittedCleanupAuthorization): Promise<Result<CleanupDisposition>>;
  previewDiscard(handle: WorktreeHandle, actor: RunnerOwnerActor): Promise<Result<DiscardObservation>>;
  discard(handle: WorktreeHandle, authorization: RetainedWorkDiscardAuthorization): Promise<Result<DiscardReceipt>>;
}
export function mayRemove(observation: WorktreeObservation): CleanupDisposition {
  if (!observation.runTerminal) return { kind: "RETAINED_LOCAL_WORK", reason: "RUN_NOT_TERMINAL" };
  if (observation.activeAttempt) return { kind: "RETAINED_LOCAL_WORK", reason: "ACTIVE_ATTEMPT" };
  if (!observation.trackedClean) return { kind: "RETAINED_LOCAL_WORK", reason: "TRACKED_CHANGES" };
  if (!observation.untrackedClean) return { kind: "RETAINED_LOCAL_WORK", reason: "UNTRACKED_FILES" };
  if (!observation.headReachableFromPublishedRef) return { kind: "RETAINED_LOCAL_WORK", reason: "UNPUBLISHED_HEAD" };
  return { kind: "REMOVE" };
}
```

`WorktreeHandle` is runner-internal and nonserializable; shared state receives only opaque keys and normalized repository-relative evidence. Creation resolves an exact full commit from the local mapping, uses shell-free Git argv, serializes per repository, persists `CREATING/READY/RETAINED/REMOVED/DISCARDED` reconciliation state in `~/.collab/runner.db`, and pins the Run only after the worktree exists through a revision CAS. Publication resolves the configured remote/ref locally, verifies the pushed exact HEAD by observing the remote, and strips credentials/path material from evidence. Automatic cleanup is non-force and rechecks every fact immediately before removal. Retained-work Publish/Discard use the separate owner authorization defined by the Product Spec; confirmation is bound to retained ID, observation digest/revision, expected HEAD, and current dirty/unpushed summary.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/runner/worktrees.test.ts`

Expected: PASS for sequential reuse, cross-run separation, pinning, exact-head publication, dirty/untracked/unpublished retention, cleanup failure, and owner-only discard.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/runs.ts src/shared/contracts/commands.ts src/runner/process-state.ts src/runner/repository/worktrees.ts src/runner/repository/publish.ts src/runner/repository/cleanup.ts tests/runner/worktrees.test.ts
git commit -m "feat: preserve agent run worktrees"
```

### Task 13: HTTP, CLI, MCP, stdio bridge, SSE, and web parity

**Requirements:** `FND-014`, web/CLI portions of `FND-003`, `FND-006`, and `ORP-03`.

**Files:**
- Create: `src/server/adapters/http/routes/{bootstrap,auth,members,projects,runs,runners,presets}.ts`
- Create: `src/server/adapters/http/{public-schemas,domain-results,security-headers}.ts`
- Create: `src/server/adapters/http/middleware/{authentication,request-limits}.ts`
- Create: `src/server/adapters/http/sse.ts`
- Create: `src/server/adapters/mcp/{server,tools}.ts`
- Create: `src/cli/{api-client,credentials}.ts`
- Create: `src/cli/commands/{start,run,cancel,resume,runner,preset,mcp}.ts`
- Create: `src/web/{api-client,projection-client}.ts`
- Create: `src/web/features/{setup,members,runs,runners,presets}/`
- Create: `src/shared/contracts/{public-api,projections}.ts`
- Test: `tests/protocol/surface-parity.test.ts`
- Test: `tests/e2e/{setup-and-members,foundation-run}.spec.ts`

**Interfaces:**
- Consumes: `ExecutionAuthority`, `IdentityAuthority`, `ProjectRegistry`, `RunnerRegistry`, preset module.
- Produces: transport-only adapters for create/inspect/cancel/resume/evidence, authenticated SSE, local stdio MCP bridge.

- [ ] **Step 1: Write the failing table-driven parity test**

```ts
for (const surface of [httpSurface(), cliSurface(), mcpSurface()]) {
  test(`${surface.name} returns canonical create inspect cancel resume evidence results`, async () => {
    const created = await surface.create(sourceFreeRunInput());
    if (!created.ok) throw new Error(created.error.code);
    const runId = created.value.run.id;
    expect((await surface.inspect({ runId })).value.run.state).toBe("QUEUED");
    expect((await surface.evidence({ runId })).value.evidence).toEqual([]);
    expect((await surface.cancel({ runId, expectedRunRevision: 1 })).ok).toBe(true);
    expect((await surface.resume(explicitResumeRequest(runId))).error?.code).toBe("RUN_TERMINAL");
  });
}
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/protocol/surface-parity.test.ts`

Expected: FAIL because HTTP, CLI, and MCP run adapters do not exist.

- [ ] **Step 3: Implement thin mappings over one fixture**

```ts
export function createRunRoutes(authority: ExecutionAuthority): Hono {
  return new Hono()
    .post("/", async (c) => encodeResult(c, await authority.execute(await parseLaunchRun(c))))
    .get("/:runId", async (c) => encodeResult(c, await authority.query(parseInspectRun(c))))
    .post("/:runId/cancel", async (c) => encodeResult(c, await authority.execute(await parseCancelRun(c))))
    .post("/:runId/resume", async (c) => encodeResult(c, await authority.execute(await parseAuthorizeAttempt(c, "RESUME"))))
    .get("/:runId/evidence", async (c) => encodeResult(c, await authority.query(parseInspectEvidence(c))));
}
```

```ts
export const mcpRunTools = [
  publicTool("collab_run_create", PublicCreateRunRequestSchema, PublicCreateRunResultSchema, handlers.createRun),
  publicTool("collab_run_inspect", PublicInspectRunRequestSchema, PublicInspectRunResultSchema, handlers.inspectRun),
  publicTool("collab_run_cancel", PublicCancelRunRequestSchema, PublicCancelRunResultSchema, handlers.cancelRun),
  publicTool("collab_run_resume", PublicResumeRunRequestSchema, PublicResumeRunResultSchema, handlers.resumeRun),
  publicTool("collab_run_evidence", PublicInspectEvidenceRequestSchema, PublicInspectEvidenceResultSchema, handlers.inspectEvidence),
] as const;
```

Public DTOs never accept actors, session IDs, scheduler/runner identities, permit/session commands, internal revocations, local paths, or connector-policy operations. HTTP, CLI, remote MCP, and the stdio bridge derive the Member/device actor from authentication and construct the same canonical commands with operation-specific input/output schemas. Hono app creation is import-safe and injected. Browser mutations require current session, exact origin, separate CSRF proof, JSON content type, and bounded request/rate limits; CLI/MCP use DPoP device credentials, never cookies. The invitation page consumes `location.hash`, immediately clears it, posts it once, and receives only a path-scoped HTTP-only invitation cookie—never the exchange secret in JSON.

Remote MCP uses the installed SDK's Streamable HTTP transport; `collab mcp` uses stdio and only proxies the same public tool definitions through the authenticated API client. It imports no authority implementation, SQLite, WSS, or React and writes only MCP frames to stdout. Authenticated SSE subscribes to a projection port, emits committed bounded schema-valid events with monotonic cursors, filters current authorization, supports typed reset on stale cursors, and bounds replay/queues/slow consumers. It never carries runner controls, permits, attachment handles, or interactive bytes.

`collab start` is canonical and `collab run` is an exact alias. CLI has deterministic exit classes and `--json`; web uses one schema-validating API/SSE client. Parity tests exercise actual Hono, compiled CLI, SDK Streamable HTTP/stdio, and isolated state. Browser E2E uses virtual WebAuthn, a real fragment exchange, cookie/CSRF assertions, two-member onboarding, preset/run flows, and committed SSE. Stateful Playwright servers use isolated temporary data or serial suites.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/protocol/surface-parity.test.ts && bun run clean && bun run build:web && bun run build:server && bun run test:e2e:run -- setup-and-members.spec.ts foundation-run.spec.ts`

Expected: PASS; all surfaces return identical values/error codes, SSE emits only committed projections, and MCP imports no SQLite, WSS, web, or policy implementation.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/public-api.ts src/shared/contracts/projections.ts src/server/adapters/http src/server/adapters/mcp src/cli src/web tests/protocol/surface-parity.test.ts tests/e2e/setup-and-members.spec.ts tests/e2e/foundation-run.spec.ts
git commit -m "feat: expose equivalent foundation surfaces"
```

### Task 14: Offline cache, durable outbox, cancellation, and reconciliation

**Requirements:** `FND-009`, remaining `FND-008`, `ORP-10`; supplies the durable fault proof deferred by Tasks 7 and 10.

**Files:**
- Create: `src/server/db/migrations/0004_foundation_operations.sql`
- Create: `src/server/db/migrations/0004_foundation_operations.verify.ts`
- Create: `src/runner/{cache,outbox,offline-policy}.ts`
- Create: `src/runner/db/migrations/0002_continuity.sql`
- Modify: `src/runner/db/migrate.ts`
- Create: `src/server/modules/runs/{event-deduplication,reconciliation}.ts`
- Modify: `src/shared/contracts/{protocol,commands,runs}.ts`
- Test: `tests/drills/{network-partition,cancellation,runner-loss}.test.ts`

**Interfaces:**
- Consumes: authority sessions, fake clock, controllable runner transport.
- Produces: inspect-only offline decision, mutation grace, structured outbox, exactly-once reconciliation, honest cancellation/loss.

- [ ] **Step 1: Write failing partition test**

```ts
test("mutation stops after grace while inspect-only continues to deadline", async () => {
  const f = createPartitionFixture({ disconnectGraceSeconds: 15 });
  const mutating = await f.start("MUTATING");
  const inspectOnly = await f.start("INSPECT_ONLY");
  f.disconnect();
  f.clock.advance(16);
  expect(f.offlinePolicy.decide(mutating)).toEqual({ action: "CHECKPOINT_AND_STOP", code: "MUTATION_LEASE_EXPIRED" });
  expect(f.offlinePolicy.decide(inspectOnly)).toEqual({ action: "CONTINUE_INSPECTION" });
  await f.reconnectWithDuplicates();
  expect(f.committedEventCount()).toBe(f.uniqueEventCount());
  expect(f.outboxText()).not.toContain(f.rawOutputCanary);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/drills/network-partition.test.ts tests/drills/cancellation.test.ts tests/drills/runner-loss.test.ts`

Expected: FAIL because local continuity and reconciliation modules are missing.

- [ ] **Step 3: Add operation persistence and offline policy**

Server migration 0004 creates durable semantic-event acceptance and closed revocation/operation intent state. Accepted events key on authenticated runner plus stable semantic event ID, not connection message ID, and persist run/attempt, schema/event kind, positive local sequence/predecessor, canonical input hash, committed result reference/disposition, and accepted time. The dedup row, lifecycle/evidence/checkpoint/result effect, audit, and acknowledgement intent commit together. Same ID/same hash replays the result; changed hash conflicts. Closed operation kinds use kind-specific validated fields/digests and never arbitrary payload JSON or the WSS dispatch outbox. Backup metadata belongs to Task 15, not this migration.

Runner-local migration 0002 adds bounded cache entries and a closed semantic event outbox to `~/.collab/runner.db`. Events retain stable ID/hash/sequence across restart and connection changes, use `PENDING/IN_FLIGHT/ACKNOWLEDGED/PERMANENTLY_REJECTED`, reserve capacity for terminal/checkpoint facts, and never contain raw output, prompts, bodies, diffs, transcripts, credentials, environment, attachment handles, or absolute paths. Cache rows are read-only authority aids with freshness/provenance and the Product Spec byte/item/age limits; they never store permits or create authority.

```ts
export function decideOffline(input: OfflineDecisionInput): OfflineDecision {
  if (input.connectedAndRenewed) return { action: "CONTINUE" };
  if (input.now >= input.attemptDeadline) return { action: "CHECKPOINT_AND_STOP", code: "ATTEMPT_DEADLINE_EXPIRED" };
  if (input.mode === "INSPECT_ONLY") return { action: "CONTINUE_INSPECTION" };
  if (input.mutationLeaseExpiresAt === undefined) return { action: "CHECKPOINT_AND_STOP", code: "MUTATION_LEASE_MISSING" };
  if (input.now >= Math.min(input.authoritySessionExpiresAt, input.mutationLeaseExpiresAt, input.disconnectedAt + input.disconnectGraceSeconds)) return { action: "CHECKPOINT_AND_STOP", code: "MUTATION_LEASE_EXPIRED" };
  return { action: "CONTINUE_MUTATION_WITH_EXISTING_LEASE" };
}
```

Reconnect order is authenticate/negotiate, fence the old connection, fetch current authoritative disposition, reconcile exact assignment/process identity, apply stop/quarantine, drain causal semantic events, then renew authority. Reconnect cannot extend deadline/grace without a committed fresh session/lease. Cancellation exposes requested, confirmed-never-started/terminated, unreachable, and eventual lost dispositions separately; only host evidence confirms `CANCELLED`/`TIMED_OUT`. At 30 seconds the runner is offline; at 90 seconds an unreconciled active Attempt becomes immutable `LOST`, authority/session/lease ends, and the Run moves to `WAITING/RUNNER_UNAVAILABLE`. A later orphan is terminated or quarantined without resurrecting the Attempt.

- [ ] **Step 4: Verify GREEN**

Run: `bun test src/server/db/migrations/0004_foundation_operations.verify.ts tests/drills/network-partition.test.ts tests/drills/cancellation.test.ts tests/drills/runner-loss.test.ts`

Expected: PASS; disconnected runners cannot renew/acquire authority or claim mutations, duplicates commit once, cancellation disposition is honest, and lost attempts become immutable `LOST` with run `WAITING`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/protocol.ts src/shared/contracts/commands.ts src/shared/contracts/runs.ts src/server/db/migrations/0004_foundation_operations.sql src/server/db/migrations/0004_foundation_operations.verify.ts src/runner/db src/runner/cache.ts src/runner/outbox.ts src/runner/offline-policy.ts src/server/modules/runs/event-deduplication.ts src/server/modules/runs/reconciliation.ts tests/drills/network-partition.test.ts tests/drills/cancellation.test.ts tests/drills/runner-loss.test.ts
git commit -m "feat: add bounded offline continuity"
```

### Task 15: Authenticated backup, isolated restore, and key rotation

**Requirements:** `FND-013`.

**Files:**
- Create: `src/server/operations/{backup,restore,key-rotation}.ts`
- Create: `src/server/commands/{backup,restore,key-rotation,auth-recover}.ts`
- Create: `src/server/command.ts`
- Modify: `src/server/db/migrations/0004_foundation_operations.sql`
- Modify: `src/server/db/migrations/0004_foundation_operations.verify.ts`
- Modify: `src/shared/environment.ts`
- Test: `tests/drills/backup-restore.test.ts`

**Interfaces:**
- Consumes: schema version 4, deployment master key outside data/backup paths, identity/runner/connector epochs.
- Produces: authenticated encrypted backup manifest, offline restore, key rotation, server command dispatcher handlers.

- [ ] **Step 1: Write failing restore safety test**

```ts
test("restore rejects the wrong key before listeners and invalidates authority", async () => {
  const f = await createOperationsFixture();
  const backup = await f.backup("key_1");
  expect((await f.restore(backup, "wrong_key")).error?.code).toBe("BACKUP_AUTHENTICATION_FAILED");
  expect(f.listenerStarted()).toBe(false);
  const restored = await f.restore(backup, "key_1");
  expect(restored.ok).toBe(true);
  expect(f.sessionCount()).toBe(0);
  expect(f.runnerEpoch()).toBeGreaterThan(backup.runnerEpoch);
  expect(f.connectorReviewState()).toBe("REVIEW_REQUIRED");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/drills/backup-restore.test.ts`

Expected: FAIL because backup and restore operations do not exist.

- [ ] **Step 3: Implement authenticated manifest and isolated restore ordering**

```ts
export type BackupManifest = Readonly<{
  format: "2COLLAB_BACKUP_V1";
  manifestVersion: 1;
  backupId: string;
  deploymentFingerprint: string;
  sourceAuthorityIncarnation: string;
  productVersion: string;
  schemaVersion: 4;
  migrationDigest: string;
  algorithm: "AES_256_GCM_CHUNKED_V1";
  keyId: string;
  chunkBytes: number;
  plaintextBytes: number;
  plaintextSha256: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  createdAt: number;
}>;
export async function restoreBackup(input: RestoreInput): Promise<Result<RestoreResult>> {
  const offline = await input.offlineCommand.acquireExclusiveDataLock();
  if (!offline.ok) return offline;
  const verified = await authenticateAndDecrypt(input.backup, input.masterKey);
  if (!verified.ok) return verified;
  if (verified.value.manifest.schemaVersion !== 4) return err("BACKUP_SCHEMA_MISMATCH", "Backup schema is incompatible.", "NEVER");
  const staged = await stageAndValidateDatabase(offline.value, verified.value.databaseBytes);
  await invalidateAuthorityAndInstallFreshIncarnation(staged);
  await requireConnectorReview(staged);
  await auditAndRevalidateStaging(staged, verified.value.manifest);
  await promoteStagedDatabaseAtomically(offline.value, staged);
  return ok({ schemaVersion: 4, connectorReview: "REQUIRED" });
}
```

The `collab-server` command root has mutually exclusive listener and offline-operation modes; restore cannot be authorized by a caller-supplied boolean and never constructs network/external workers. Backups use a SQLite-consistent snapshot, restrictive temp files, fsync+atomic rename, independently reopen/decrypt/integrity-verify before success, and retain the previous verified backup on failure. The strict canonical authenticated manifest and chunked AES-256-GCM/HKDF key hierarchy follow the Product Spec. Master key comes from a secret file outside data/backup paths.

Migration 0004 adds deployment authority incarnation/restore marker, versioned wrapped credential-class keys, constrained credential algorithm/key-version metadata, resumable rotation state, and safe backup/retention audit metadata. Restore invalidates every session/challenge/pairing/capability/permit/authority/lease/operation proof, advances epochs, holds queued external writes, and preserves immutable history before staging promotion. Credential-class rotation rewrites only its class and activates after full verification; master-key rotation rewraps data keys and accounts for retained backups. Retention is finite but never deletes the sole verified usable backup.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/drills/backup-restore.test.ts`

Expected: PASS for authentication tag, manifest digest, wrong/missing key, schema mismatch, isolated restore, session invalidation, epoch increments, old-permit rejection, connector review, and audited key rotation.

- [ ] **Step 5: Commit**

```bash
git add src/shared/environment.ts src/server/db/migrations/0004_foundation_operations.sql src/server/db/migrations/0004_foundation_operations.verify.ts src/server/operations src/server/commands src/server/command.ts tests/drills/backup-restore.test.ts
git commit -m "feat: add authenticated recovery operations"
```

### Task 16: Composition roots, environment, packaging, and complete verification graph

**Requirements:** composition ownership for all Foundation requirements.

**Files:**
- Modify: `src/server/{app,index}.ts`
- Create: `src/server/{command,dependencies}.ts`
- Modify: `src/cli/{command,index}.ts`
- Create: `src/cli/dependencies.ts`
- Modify: `src/web/app.tsx`
- Modify: `src/shared/environment.ts`
- Modify: `package.json`
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example`
- Modify: `playwright.config.ts`
- Modify: `public-manifest.json`
- Create: `tests/scripts/compose-config-with-temporary-secrets.sh`
- Test: `tests/integration/composition.test.ts`

**Interfaces:**
- Consumes: all Foundation module constructors and validated environment supplied only at the
  executable boundary.
- Produces: import-safe `createApp(dependencies)`, `createCli(dependencies)`, pure dependency
  factories, server command dispatch, complete test scripts, canonical Compose inputs, and bounded
  readiness/shutdown behavior.

- [ ] **Step 1: Write failing composition test**

```ts
test("composition injects state and package test includes every suite", async () => {
  const app = createApp(createTestDependencies());
  expect((await app.request("/healthz")).status).toBe(200);
  expect((await app.request("/api/v1/runs", { method: "POST", body: JSON.stringify(sourceFreeRunInput()) })).status).toBe(201);
  const pkg = await Bun.file("package.json").json();
  expect(pkg.scripts.test).toContain("tests/protocol");
  expect(pkg.scripts.test).toContain("tests/runner");
  expect(pkg.scripts.test).toContain("tests/drills");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/integration/composition.test.ts`

Expected: FAIL because current composition roots expose only the seed application and incomplete test graph.

- [ ] **Step 3: Wire explicit dependencies and operational configuration**

```ts
export type AppDependencies = Readonly<{
  identity: IdentityAuthority;
  browserSessions: BrowserSessionAuthority;
  csrf: CsrfAuthority;
  projects: ProjectRegistry;
  runners: RunnerRegistry;
  runnerTransport: RunnerTransportAuthority;
  runnerAuthentication: RunnerAuthenticationAuthority;
  deviceAuthorization: DeviceAuthorizationAuthority;
  authority: ExecutionAuthority;
  presets: PersonalRunPresets;
  operations: OperationAuthority;
  backups: BackupAuthority;
  mcp: McpSurface;
  events: ProjectionEvents;
  readiness: ReadinessProbe;
  limits: PublicRequestLimits;
}>;
export function createApp(deps: AppDependencies, options: AppOptions = {}): Hono {
  const app = new Hono();
  app.get("/healthz", healthHandler());
  app.get("/readyz", readinessHandler(deps.readiness));
  app.route("/api/v1/bootstrap", createBootstrapRoutes(deps.identity));
  app.route("/api/v1/auth", createAuthRoutes(deps.identity));
  app.route("/api/v1/invitations/exchange", createInvitationExchangeRoutes(deps.identity));
  app.route("/api/v1/device", createDeviceAuthorizationRoutes(deps.deviceAuthorization));
  app.use("/api/v1/*", publicBodyLimit(deps.limits));
  app.use("/api/v1/*", browserSessionMiddleware(deps.browserSessions));
  app.use("/api/v1/*", csrfMiddleware(deps.csrf));
  app.route("/api/v1/projects", createProjectRoutes(deps.projects));
  app.route("/api/v1/runners", createRunnerRoutes(deps.runners));
  app.route("/api/v1/runs", createRunRoutes(deps.authority));
  app.route("/api/v1/presets", createPresetRoutes(deps.presets));
  app.route("/api/v1/operations", createOperationRoutes(deps.operations));
  app.route("/api/v1/backups", createBackupRoutes(deps.backups));
  app.route("/mcp", createMcpRoutes(deps.mcp));
  app.get("/runner/v1", createRunnerWebSocketUpgrade(deps.runnerAuthentication, deps.runnerTransport));
  app.get("/api/v1/events", createAuthenticatedSseHandler(deps.browserSessions, deps.events));
  return attachSeedRoutesAndStaticFiles(app, options);
}
```

The order above is a trust boundary, not presentation preference. Health and readiness are public and
bounded. Bootstrap/authentication/invitation exchange/device authorization have their own
purpose-bound pre-authentication principals. Browser session and CSRF checks cover every stateful
browser API but do not run in front of MCP bearer/DPoP authentication or runner WSS authentication.
Runner WebSocket upgrades authenticate the pairing/access credential before protocol dispatch. SSE
requires an ordinary browser session. Static assets and the browser-history fallback are registered
last and never consume `/api`, `/mcp`, or `/runner` traffic.

`createServerDependencies(environment, resources)` and `createCliDependencies(environment,
resources)` are pure factories: they receive the already-open database, clock, crypto, connector
clients, runner listener, filesystem adapters, and logger. Importing app, CLI, or command modules must
not read environment variables, open SQLite, bind a port, create directories, start timers, or launch
processes. `src/server/index.ts` is the only server executable boundary. It validates environment,
opens/migrates storage, constructs dependencies, reconciles startup state, starts listeners, and owns
graceful shutdown. `src/cli/index.ts` is likewise the only CLI executable boundary.

The build produces the two canonical Product Spec artifacts: the portable `collab-server` executable
and host-specific `collab` executable. The container runs `collab-server serve`; offline server
operations remain `collab-server backup`, `restore`, `key`, and `auth recover`. `collab mcp-stdio`
runs through the same injected MCP command handlers and `ExecutionAuthority` rather than importing
HTTP route code. `collab start` and its exact `collab run`
alias resolve the canonical server origin, load local project identity, acquire device credentials,
and call the same public command contract as Web and MCP.

Environment parsing is strict and allowlisted. Unknown `COLLAB_` server variables are rejected.
Secrets are accepted only through mounted files, with regular-file/no-symlink/owner-only permission
checks and bounded reads; their contents never enter errors or diagnostics. Development-only HTTP is
limited to exact `localhost`. Proxy headers are trusted only when the explicit proxy-trust policy
matches the direct peer. `/healthz` proves only that the process loop is alive. `/readyz` remains
non-ready until migration, key loading, authority-incarnation initialization, backup staging cleanup,
and startup reconciliation have succeeded. Shutdown stops new work, closes upgrade paths, asks the
runner transport to quiesce, records unresolved attempts honestly, closes SQLite, and exits within the
bounded grace period.

```json
{
  "scripts": {
    "test": "bun run test:unit && bun run test:integration && bun run test:protocol && bun run test:runner && bun run test:drills",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration",
    "test:protocol": "bun test tests/protocol",
    "test:runner": "bun test tests/runner",
    "test:drills": "bun test tests/drills",
    "test:e2e": "bun run clean && bun run build:web && bun run build:server && bun run test:e2e:run",
    "verify": "bun ci && bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build && bun run test:e2e:run && bun run audit:public && bun run manifest:verify && bun run archive:verify"
  }
}
```

Compose must require `SESSION_SECRET`, `PUBLIC_BASE_URL`, `WEBAUTHN_RP_ID`, `DEPLOYMENT_MASTER_KEY_FILE`, `BOOTSTRAP_SECRET_FILE`, and `BACKUP_DIR`; mount master/bootstrap secrets read-only outside `/data`, mount a separate backup volume, retain the read-only root, tmpfs, dropped capabilities, and no-new-privileges.

The runtime image contains the compiled `collab-server` executable and launches `collab-server serve`. Its
healthcheck uses `/readyz`, not `/healthz`, so a process with failed migrations, invalid keys, or
incomplete reconciliation is never advertised ready. The image contains no compiler, source tree,
development dependencies, tests, lockfile, package-manager cache, host-native artifacts, or default
secret. It runs as an unprivileged numeric user, uses a read-only root filesystem, writes only to the
explicit data/backup volumes and bounded tmpfs, drops every capability, and requests no-new-privileges.

```yaml
services:
  collab-server:
    build:
      context: .
      target: runtime
    environment:
      SESSION_SECRET: ${SESSION_SECRET:?SESSION_SECRET is required}
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:?PUBLIC_BASE_URL is required}
      WEBAUTHN_RP_ID: ${WEBAUTHN_RP_ID:?WEBAUTHN_RP_ID is required}
      DEPLOYMENT_MASTER_KEY_FILE: /run/secrets/deployment_master_key
      BOOTSTRAP_SECRET_FILE: /run/secrets/bootstrap_secret
      BACKUP_DIR: /backups
    secrets:
      - deployment_master_key
      - bootstrap_secret
    volumes:
      - collab-data:/data
      - collab-backups:/backups
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
secrets:
  deployment_master_key:
    file: ${DEPLOYMENT_MASTER_KEY_FILE:?DEPLOYMENT_MASTER_KEY_FILE is required}
  bootstrap_secret:
    file: ${BOOTSTRAP_SECRET_FILE:?BOOTSTRAP_SECRET_FILE is required}
volumes:
  collab-data:
  collab-backups:
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/integration/composition.test.ts && bash tests/scripts/compose-config-with-temporary-secrets.sh`

Expected: PASS; all feature routes precede bounded catch-alls, each route has the correct independent
trust boundary, CLI/server/MCP-stdio commands are reachable, readiness and shutdown are bounded,
required secret files/config validate without reusing `.env.example` as secret material, and every
non-browser suite is in `bun run test`.

- [ ] **Step 5: Commit**

```bash
git add src/server src/cli src/web/app.tsx src/shared/environment.ts package.json bun.lock Dockerfile compose.yaml .github/workflows/ci.yml .env.example playwright.config.ts public-manifest.json tests/integration/composition.test.ts tests/scripts/compose-config-with-temporary-secrets.sh
git commit -m "feat: compose foundation artifacts"
```

### Task 17: Local acceptance matrix, security drills, and evidence record

**Requirements:** local executable proof for `FND-001` through `FND-018`; initializes `FND-019`.

**Files:**
- Create: `tests/drills/{identity-replay,runner-security,storage-canary,offboarding-active-run}.test.ts`
- Create: `tests/evidence/foundation-matrix.ts`
- Create: `tests/unit/evidence/foundation-matrix.test.ts`
- Create: `scripts/verify-evidence.ts`
- Create: `docs/evidence/foundation/EVIDENCE-TEMPLATE.md`
- Create: `docs/evidence/foundation/<build-id>.md`
- Create: `docs/evidence/foundation/DOGFOOD-LEDGER.md`
- Modify: `package.json`
- Modify: `MANIFEST.sha256`
- Modify: `tests/e2e/{setup-and-members,foundation-run}.spec.ts`

**Interfaces:**
- Consumes: packaged `collab-server`, compiled `collab`, all local fixtures, and the canonical
  Acceptance Matrix.
- Produces: a machine-validated proof-obligation registry, one neutral template, one build-specific
  local evidence record with exact artifact identity, and an honest external/timed evidence ledger.

- [ ] **Step 1: Add a failing prohibited-storage canary drill**

```ts
test("raw canaries never enter server stores, backups, or outboxes", async () => {
  const f = await createStorageCanaryFixture();
  const canaries = await f.injectSeparateAllowedAndForbiddenChannels();
  await f.exerciseLaunchCheckpointEvidenceBackupReconnectRestoreAndBrowserInspection();
  const stores = await f.inspectEveryExpectedStore();
  expect(stores.map((store) => store.id).sort()).toEqual(EXPECTED_PROHIBITED_STORE_IDS);
  for (const store of stores) {
    expect(store.readable).toBe(true);
    for (const encodedCanary of forbiddenCanaryEncodings(canaries.forbidden)) {
      expect(store.bytes.includes(encodedCanary)).toBe(false);
    }
  }
  expect(f.allowedStructuredInstruction()).toContain(canaries.allowedAuthoredInstruction);
});
```

Generate distinct runtime canaries for the allowed authored goal/instruction and for prohibited raw
source or document bodies, flattened prompts, terminal stdout/stderr, interactive PTY input/output,
environment secrets, connector credentials, private profile arguments, POSIX and Windows absolute
paths, worktree contents, raw diffs, and attachment handles. Search raw, JSON-escaped, URL-encoded,
and base64 forms. Hashes and approved structured authored instruction fields are not false positives.
The expected inventory is closed: shared SQLite/WAL/SHM and logical tables, server logs, idempotency,
audit/projection/outbox state, verified backup ciphertext, independently restored logical contents and
staging files; runner SQLite/WAL/SHM, context cache, semantic outbox, reconciliation state, logs and
encrypted diagnostic metadata/ciphertext; CLI captures; browser storage/caches/network captures; and
generated Playwright artifacts. Missing, unreadable, silently skipped, or unexpected durable stores
fail the drill.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/drills/identity-replay.test.ts tests/drills/runner-security.test.ts tests/drills/storage-canary.test.ts tests/drills/offboarding-active-run.test.ts`

Expected: FAIL on the first unimplemented drill fixture or prohibited persistence path.

- [ ] **Step 3: Complete drills and create the exact evidence registry and formats**

```markdown
# Foundation Evidence Template

- Schema version: 1
- Package status: NOT_RUN
- Foundation status: NOT_STARTED
- Canonical exit criterion: NOT_EVALUATED
- Required per-command result: NOT_RUN | PASS | FAIL | BLOCKED_ENV
- Required per-requirement status: NOT_STARTED | IN_PROGRESS_LOCAL | LOCAL_PROOF_COMPLETE | IN_PROGRESS_EXTERNAL | PASS | FAIL
- Required artifact fields: tested repository commit, dirty-tree state, build identifier, Bun/platform/architecture, bun.lock digest, build-manifest digest, compiled collab digest, server artifact/image digest, start/end/duration
- Required proof fields: requirement and obligation IDs, exact command, exit code, result, safe audit/event/run IDs or MISSING, human reviewer state, limitations, external/live status
- Direct SQLite repair definition: any manual statement or file edit that changes authoritative database contents outside shipped migrations, restore, or supported commands
```

```ts
export const localFoundationMatrix = Object.freeze([
  {
    requirementId: "FND-001",
    proofObligations: [
      { id: "EMPTY_BOOTSTRAP_ONE_OWNER", evidenceKind: "BROWSER_E2E", testPath: "tests/e2e/setup-and-members.spec.ts", testName: "empty volume bootstrap creates exactly one team and owner" },
      { id: "RESTORE_PRESERVES_SINGLETON", evidenceKind: "RESTORE_DRILL", testPath: "tests/drills/backup-restore.test.ts", testName: "isolated restore preserves one-team bootstrap invariant" },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  // FND-002 through FND-018 enumerate every Acceptance Matrix behavior at exact test-name
  // granularity. FND-005 remains IN_PROGRESS_EXTERNAL until its real two-machine runtime/host/mode
  // matrix completes. FND-019 contains the seven-consecutive-day obligation and cannot pass here.
]);
```

`verify-evidence` parses canonical `FND-001` through `FND-019` from the Acceptance Matrix and rejects
missing, duplicate, unknown, out-of-order, stale, directory-only, or nonexistent test references. It
requires every Acceptance Matrix test level and exact proof behavior, derives statuses from individual
command results, and rejects `PASS` for skipped, blocked, failed, live-pending, timed-pending, or
unreviewed obligations. File existence never proves behavior. FND-005 includes local adapter/host
conformance plus a separate real two-machine/runtime/host/mode obligation. FND-019 is a timed external
obligation only.

The build-specific record is `docs/evidence/foundation/<build-id>.md`, not the neutral template. It
records every gate command separately with exit code and `PASS`, `FAIL`, `BLOCKED_ENV`, or `NOT_RUN`;
safe evidence identifiers are `MISSING` when not emitted and reviewer is `UNREVIEWED` until an actual
human review. Raw output, credentials, environment values, source/document bodies, flattened prompts,
diffs, private paths/provider URLs, transcripts, and private runner/profile details are prohibited.
The package may be `PACKAGE_LOCAL_VERIFIED` after all local/package/container checks pass while the
Foundation phase remains `IN_PROGRESS_EXTERNAL` and its canonical exit remains `NOT_MET`.

Avoid manifest self-reference. Generate a separate tested-build artifact manifest outside the source
inventory and record its digest in the build evidence; then regenerate `MANIFEST.sha256`, which hashes
the evidence document normally but not itself. The evidence record identifies the exact tested
implementation commit and states when the later evidence commit was not itself that build.

Initialize `DOGFOOD-LEDGER.md` with zero completed days, owners, and machines; empty build/run/
incident/migration/restart/backup/restore rows; zero observed repairs so far rather than a period-wide
proof; timezone and consecutive-day rule; no-backfill rule; the exact direct-repair definition; human
reviewer `UNREVIEWED`; and this canonical criterion verbatim: "Exit when both owners can start headless
and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit
replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server
backup and isolated restore drills pass; and one week of dogfood produces no need for direct database
repair."

- [ ] **Step 4: Run the complete local gate**

Run each command separately and record each result: `bun ci`; `bun run format:check`; `bun run lint`;
`bun run typecheck`; `bun run test`; `bun run build`; `bunx playwright install chromium`;
`bun run test:e2e:run`; `bun run audit:public`; `bun run manifest:verify`; `bun run archive:verify`;
`bash tests/scripts/compose-config-with-temporary-secrets.sh`; `docker build --tag 2collab:verify .`;
the compiled `collab` smoke; packaged `collab-server serve` listener/readiness/shutdown smoke; live hardened
container readiness; authenticated backup create/verify; offline isolated restore verify; and
`bun run evidence:verify`.

Expected: every locally achievable command exits 0 and the build-specific record includes exact
artifact identities. Environment failures are `BLOCKED_ENV`, code/test failures are `FAIL`, and no
unrun or live/timed check is marked passed. FND-005/FND-019 and the overall Foundation exit remain
external-in-progress even when the package is locally verified.

- [ ] **Step 5: Commit**

```bash
git add tests/drills tests/e2e tests/evidence tests/unit/evidence scripts/verify-evidence.ts docs/evidence/foundation package.json MANIFEST.sha256
git commit -m "test: prove foundation locally"
```

### Task 18: Timed and two-machine evidence ledger

**Requirements:** external execution proof for `FND-005`, `FND-013`, `FND-019`; does not block subsequent implementation work.

**Files:**
- Modify: `docs/evidence/foundation/DOGFOOD-LEDGER.md`
- Create: `docs/evidence/foundation/{OPERATOR-RUNBOOK,MACHINE-EVIDENCE-TEMPLATE,RESTORE-DRILL-TEMPLATE}.md`
- Create: `scripts/evidence/foundation-contract.ts`
- Create: `scripts/{foundation-evidence,foundation-restore-drill}.ts`
- Modify: `package.json`
- Modify: `MANIFEST.sha256`
- Test: `tests/unit/evidence/{foundation-live-schema,foundation-matrix,consecutive-days,dogfood-ledger}.test.ts`
- Test: `tests/scripts/foundation-evidence.test.ts`
- Test: `tests/drills/copied-backup-procedure.test.ts`

**Interfaces:**
- Consumes: exact verified build from Task 17, two trusted owners/machines, copied encrypted backup,
  injected clock/filesystem/command-executor adapters, and later authenticated operator observations.
- Produces now: strict evidence schemas, safe dry-run operator tooling, an internally valid pending
  ledger, and separate structural/exit validators. Produces only after real execution: sixteen
  machine/runtime/host/mode rows, an isolated copied-backup restore result, and seven consecutive
  reviewed daily entries.

- [ ] **Step 1: Write failing evidence-contract and operator-safety tests**

```ts
test("the initialized ledger validates but does not satisfy the Foundation exit", async () => {
  const fixture = createFoundationEvidenceFixture();
  await fixture.initialize();
  expect(await fixture.validate()).toEqual({ status: "IN_PROGRESS_EXTERNAL" });
  expect((await fixture.checkExit()).code).toBe("FOUNDATION_EXIT_NOT_MET");
});

test("restore tooling refuses production or existing volumes and defaults to dry-run", async () => {
  const fixture = createRestoreDrillFixture();
  expect((await fixture.plan({ target: fixture.productionProject })).code).toBe("RESTORE_TARGET_UNSAFE");
  expect(await fixture.plan({ target: fixture.newIsolatedProject })).toMatchObject({ mode: "DRY_RUN", listeners: "DISABLED" });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/unit/evidence tests/scripts/foundation-evidence.test.ts tests/drills/copied-backup-procedure.test.ts`

Expected: FAIL because the live evidence contract, derived streak/status logic, and safe restore planner do not exist.

- [ ] **Step 3: Implement evidence machinery and initialize an honest pending ledger**

Use closed UPPERCASE result/status values and strict schemas. `foundation-evidence` exposes `init`,
`enroll-machine`, `record-run`, `record-restore`, `close-day`, `status`, `validate`, and `check-exit`.
It never accepts manual aggregate statuses. `validate` succeeds for structurally consistent pending
evidence; `check-exit` remains nonzero until every external obligation is actually satisfied.

The machine matrix is exactly two owners/machines x `CLAUDE|CODEX` x `NATIVE|ORCA` x
`HEADLESS|INTERACTIVE` = sixteen required tuples. Each row records schema/evidence/build/artifact IDs;
opaque owner, machine, runner, run and attempt IDs; runner epoch and policy/mapping/profile revisions;
safe profile fingerprint; runtime, host, mode and `WEB|CLI` launch surface; UTC start/terminal times;
attempt lifecycle separately from run result; actual host-adapter provenance; interactive local-presence
and shared-transport privacy results; `NOT_RUN|PASS|FAIL|BLOCKED_ENV`; reviewer and review time; and
bounded safe notes. Each tuple has at least one accepted row, both owners use both Web and CLI, and
each owner demonstrates headless and interactive across both surfaces. All rows use the same frozen
Task 17 build; there is no fallback/substitution or transcript/keystroke content.

The ledger locks one IANA timezone before day one. `close-day` derives local date from a trusted
injected clock and does not accept a date argument. Rows are append-only; corrections are new records
referencing the original. Reject future, duplicate, and out-of-order dates. A missing calendar date,
direct database repair, incomplete/failed/unreviewed day, build change, or invalid evidence resets the
derived streak. DST does not affect calendar-date consecutiveness. A machine replacement invalidates
that machine's matrix coverage. Each day identifies the frozen tested build, safe run IDs/count,
incidents or `NONE`, migrations/restarts or `NONE`, backup result, current restore-drill reference,
repair result, recorded-at UTC time, and authenticated reviewer. Zero initial repairs means only none
observed yet.

`foundation-restore-drill` defaults to `--dry-run`. `--apply` requires a separately copied encrypted
backup, its matching source/destination SHA-256, separately mounted master-key file (record key ID
only), and a generated isolated Compose project. It refuses production project names, existing/live
data volumes, shared backup/data paths, published ports before completion, and broad cleanup commands.
The generated target uses a brand-new empty volume, read-only copied backup/key mounts, no runners or
connectors, and no listener during verify/apply. It performs `collab-server restore verify` and the
actual offline `collab-server restore apply`, then proves a fresh authority incarnation, invalid
sessions/capability chains/old permits, advanced runner/connector epochs, connector
`REVIEW_REQUIRED`, and no pre-completion listener. Optional inspection boots only the isolated target
on a distinct loopback port; cleanup removes only generated labeled resources.

The human-readable ledger is derived from validated structured evidence and starts with zero days,
owners, machines and rows, `UNREVIEWED`, Foundation `IN_PROGRESS_EXTERNAL`, and exit `NOT_MET`.
Templates and runbook prohibit secrets, environment values, raw arguments, transcripts, terminal
content, provider URLs, private paths, or manually asserted `PASS`. The runbook distinguishes building
the machinery now from later operator evidence commits.

Package scripts:

```json
{
  "evidence:validate": "bun run scripts/foundation-evidence.ts validate",
  "evidence:foundation-exit": "bun run scripts/foundation-evidence.ts check-exit"
}
```

- [ ] **Step 4: Verify the machinery and pending state**

Run: `bun test tests/unit/evidence tests/scripts/foundation-evidence.test.ts tests/drills/copied-backup-procedure.test.ts && bun run evidence:validate`

Expected: PASS; the pending ledger is structurally valid. Separately run `bun run
evidence:foundation-exit`; expected now: nonzero with stable `FOUNDATION_EXIT_NOT_MET`. This expected
pending exit is not a package failure and must not be rewritten as `PASS`.

- [ ] **Step 5: Commit the machinery and initialized pending evidence**

```bash
git add docs/evidence/foundation scripts/evidence scripts/foundation-evidence.ts scripts/foundation-restore-drill.ts tests/unit/evidence tests/scripts/foundation-evidence.test.ts tests/drills/copied-backup-procedure.test.ts package.json MANIFEST.sha256
git commit -m "feat: add foundation live evidence machinery"
```

The following steps are operator work after Task 17's exact build is frozen. They are not fabricated,
do not block GitHub/Outline/Automation implementation, and land only as later evidence commits.

- [ ] **External Step A: Execute the two-machine matrix**

Run on each trusted machine: `collab doctor && collab runner status && collab run --preset foundation-headless "Record Foundation runtime evidence" && collab run --preset foundation-interactive "Record Foundation interactive evidence"`

Expected: both owners record Claude and Codex through Native and Orca in HEADLESS and INTERACTIVE modes; interactive bytes remain local and shared evidence contains safe metadata only.

- [ ] **External Step B: Execute copied isolated restore evidence**

Run the reviewed `foundation-restore-drill --apply` procedure against a copied encrypted backup and a
new isolated target. Do not select the deployment's Compose project, data volume, or backup volume.

Expected: copied digest equality, offline verify and apply, fresh authority incarnation, invalid old
sessions/capabilities/permits, advanced runner/connector epochs, connectors requiring review, and no
listener before completion.

- [ ] **External Step C: Record seven consecutive days without direct repair**

```markdown
## Daily entry schema

- Date: ISO-8601 calendar date
- Repository revision: full commit SHA
- Build identifier: immutable build identifier
- Runs: count plus run identifiers
- Incidents: count plus safe correlation identifiers
- Migrations or restarts: supported operation identifiers
- Backup and restore result: PASS or FAIL
- Direct SQLite repair: YES or NO
- Reviewer: authenticated member identifier
```

Expected: seven consecutive completed entries, zero direct SQLite repairs, and no missing build/run/incident/restore fields. Until then `FND-019` remains `IN_PROGRESS`.

- [ ] **External Step D: Validate, review, and commit completed evidence**

Run: `bun run evidence:validate && bun run evidence:foundation-exit`

Expected only after authentic observations: both commands exit 0. Before that, Foundation remains
`IN_PROGRESS_EXTERNAL` and the canonical exit is `NOT_MET`.

```bash
git add docs/evidence/foundation
git commit -m "docs: record foundation dogfood evidence"
```

## Self-Review Record

- Coverage: Tasks 2-4 cover `FND-001`/`FND-002`; Task 5 `FND-003`; Tasks 6-8 `FND-004`/`FND-005`/`FND-012`/`FND-015`/`FND-018`; Tasks 9-12 cover `FND-006`-`FND-011`/`FND-016`/`FND-017`; Task 13 covers `FND-014`; Task 14 completes `FND-008`/`FND-009`; Task 15 covers `FND-013`; Tasks 17-18 cover evidence and `FND-019`.
- Type consistency: all callers consume `Result<T>` and the same `ExecutionAuthority.preview/execute/query`; resume is `AUTHORIZE_ATTEMPT` with cause `RESUME`; evidence reads use `INSPECT_EVIDENCE`.
- Ordering: migrations are `0001 -> 0002 -> 0003 -> 0004`; authority commits before WSS delivery; restore verifies before listeners; subsequent code may proceed while Task 18 remains `IN_PROGRESS`.
- Placeholder scan: the plan contains no deferred implementation markers, generic error-handling instructions, or undefined implementation steps.
