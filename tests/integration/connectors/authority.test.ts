import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  type AttemptOperationAuthorityPort,
  createConnectorAuthority,
} from "../../../src/server/modules/connectors/connector-authority.ts";
import type {
  ConnectorOperationAuthorization,
  ExactRevisionMutation,
  Observed,
  SourceConnector,
} from "../../../src/server/modules/connectors/contract.ts";
import { createProjectionCodec } from "../../../src/server/modules/connectors/contract.ts";

const digest = "a".repeat(64);
type Projection = Readonly<{ title: string }>;
type Mutation = Readonly<{ kind: "SET_TITLE"; title: string }>;

function fixture(overrides: Readonly<{ beforeConfirmationCommit?: () => void }> = {}) {
  const database = openDatabase(":memory:");
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES ('member_1', 'Ada', 'MEMBER', 'ACTIVE', 1, 1, 0);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
      absolute_expires_at, member_authority_epoch, revision, created_at
    ) VALUES (
      'session_1', 'member_1', X'${"11".repeat(32)}', 'BROWSER', 10000, 10000, X'${"12".repeat(32)}',
      10000, 1, 1, 0
    );
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
      VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
    INSERT INTO connector_epochs(connector_id, epoch, review_state)
      VALUES ('connector_1', 1, 'READY');
    INSERT INTO connector_scopes(
      id, project_id, connector_id, connector_epoch, revision, created_at
    ) VALUES ('scope_1', 'project_1', 'connector_1', 1, 1, 0);
    INSERT INTO connector_scope_references(scope_id, reference) VALUES ('scope_1', 'issue_42');
    INSERT INTO connector_scope_operations(scope_id, operation) VALUES ('scope_1', 'SET_TITLE');
    INSERT INTO connector_projections(
      project_id, connector_id, reference, connector_epoch, source_revision,
      comparable_digest, projection_revision, observed_at, freshness,
      provenance_kind, projection_json
    ) VALUES (
      'project_1', 'connector_1', 'issue_42', 1, 'etag-1', '${digest}', 1, 50,
      'FRESH', 'RECONCILIATION', '{"title":"Current"}'
    );
  `);
  let sequence = 0;
  let calls = 0;
  let consumed = 0;
  const connector: SourceConnector<string, Projection, Mutation> = {
    async inspect() {
      throw new Error("not used");
    },
    async mutate(
      authorization: ConnectorOperationAuthorization,
      command: ExactRevisionMutation<Mutation>,
    ) {
      calls += 1;
      expect(authorization.kind).toBe("CONNECTOR_OPERATION");
      return {
        ok: true,
        value: {
          value: { title: command.mutation.title },
          reference: "issue_42",
          sourceRevision: "etag-2",
          comparableDigest: "b".repeat(64) as never,
          projectionRevision: 0,
          observedAt: 100,
          freshness: "FRESH",
          provenance: {
            projectId: "project_1" as never,
            connectorId: "connector_1" as never,
            connectorEpoch: 1,
            kind: "MUTATION_CONFIRMATION",
          },
        } satisfies Observed<Projection>,
      };
    },
    async *scan() {
      yield* [];
    },
  };
  const attemptAuthority: AttemptOperationAuthorityPort = {
    async verify(input) {
      return input.authorizationId === "operation_1"
        ? { ok: true, value: { actorId: "attempt_1" } }
        : {
            ok: false,
            error: {
              code: "OPERATION_AUTHORIZATION_INVALID",
              message: "Operation authorization is invalid.",
              retry: "NEVER",
            },
          };
    },
    async consume(input) {
      consumed += 1;
      return input.authorizationId === "operation_1"
        ? { ok: true, value: { consumed: true } }
        : {
            ok: false,
            error: {
              code: "OPERATION_AUTHORIZATION_INVALID",
              message: "Operation authorization is invalid.",
              retry: "NEVER",
            },
          };
    },
  };
  const dependencies = {
    database,
    clock: () => 100,
    id: (prefix: string) => `${prefix}_${++sequence}`,
    digest: async () => Uint8Array.from({ length: 32 }, () => 0x11),
    attemptAuthority,
    projectionCodec: () => createProjectionCodec(z.object({ title: z.string().max(120) }).strict()),
    ...overrides,
  };
  const authority = createConnectorAuthority(dependencies);
  const command: ExactRevisionMutation<Mutation> = {
    projectId: "project_1" as never,
    connectorId: "connector_1" as never,
    connectorEpoch: 1,
    idempotencyKey: "mutation_1",
    precondition: {
      kind: "EXACT_REVISION",
      sourceRevision: "etag-1",
      comparableDigest: digest as never,
    },
    actionDigest: digest as never,
    mutation: { kind: "SET_TITLE", title: "Updated" },
  };
  return {
    authority,
    restart: () => createConnectorAuthority(dependencies),
    connector,
    command,
    database,
    calls: () => calls,
    consumed: () => consumed,
  };
}

describe("ConnectorAuthority", () => {
  test("only an active owner can idempotently advance connector authority with an audit id", async () => {
    const f = fixture();
    try {
      f.database.exec("UPDATE members SET role = 'OWNER' WHERE id = 'member_1'");
      const command = {
        actor: {
          kind: "MEMBER" as const,
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        idempotencyKey: "epoch_advance_1",
        connectorId: "connector_1",
        expectedEpoch: 1,
        expectedRevision: 1,
        reviewState: "REVIEW_REQUIRED" as const,
      };
      const changed = await f.authority.changeEpoch(command);
      expect(changed.ok).toBe(true);
      if (!changed.ok) return;
      expect(changed.value).toMatchObject({ epoch: 2, revision: 2 });
      expect(changed.auditId).toMatch(/^audit_/);
      expect(await f.authority.changeEpoch(command)).toEqual(changed);
    } finally {
      f.database.close();
    }
  });

  test("ordinary ACTIVE members enter the shared mutation path without an authority session", async () => {
    const f = fixture();
    try {
      const result = await f.authority.mutateAsMember(f.connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      expect(result.ok).toBe(true);
      expect(f.calls()).toBe(1);
    } finally {
      f.database.close();
    }
  });

  test("create operations persist the provider-confirmed source identity instead of the reservation reference", async () => {
    const f = fixture();
    try {
      f.database
        .query(
          "INSERT INTO connector_scope_references(scope_id, reference) VALUES ('scope_1', 'repository_1')",
        )
        .run();
      const connector: SourceConnector<string, Projection, Mutation> = {
        async inspect() {
          throw new Error("not used");
        },
        async mutate(_authorization, command) {
          return {
            ok: true,
            value: {
              value: { title: command.mutation.title },
              reference: "issue_43",
              sourceRevision: "etag-created",
              comparableDigest: "f".repeat(64) as never,
              projectionRevision: 0,
              observedAt: 100,
              freshness: "FRESH",
              provenance: {
                projectId: command.projectId,
                connectorId: command.connectorId,
                connectorEpoch: command.connectorEpoch,
                kind: "MUTATION_CONFIRMATION",
              },
            },
          };
        },
        async *scan() {
          yield* [];
        },
      };
      const result = await f.authority.mutateAsMember(connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "repository_1",
        operation: "SET_TITLE",
        command: {
          ...f.command,
          idempotencyKey: "create_43" as never,
          precondition: { kind: "ABSENT" },
        },
      });
      expect(result).toMatchObject({ ok: true, value: { reference: "issue_43" } });
      expect(
        f.database
          .query<{ reference: string }, []>(
            "SELECT reference FROM connector_projections WHERE reference = 'issue_43'",
          )
          .get(),
      ).toEqual({ reference: "issue_43" });
    } finally {
      f.database.close();
    }
  });

  test("human connector mutation rejects a browser session at the shared idle deadline", async () => {
    const f = fixture();
    try {
      f.database.exec("UPDATE sessions SET idle_expires_at = 100 WHERE id = 'session_1'");
      const result = await f.authority.mutateAsMember(f.connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("SESSION_INVALID");
    } finally {
      f.database.close();
    }
  });

  test("attempt writes consume exact operation authority then use the same persistence path", async () => {
    const f = fixture();
    try {
      const result = await f.authority.mutateAsAttempt(f.connector, {
        authorizationId: "operation_1",
        authorizationProof: "operation-proof-with-at-least-thirty-two-bytes",
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      expect(result.ok).toBe(true);
      expect(
        (
          await f.authority.mutateAsAttempt(f.connector, {
            authorizationId: "operation_1",
            authorizationProof: "operation-proof-with-at-least-thirty-two-bytes",
            reference: "issue_42",
            operation: "SET_TITLE",
            command: f.command,
          })
        ).ok,
      ).toBe(true);
      expect(f.consumed()).toBe(1);
      expect(f.calls()).toBe(1);
    } finally {
      f.database.close();
    }
  });

  test("same idempotency key and input replays while changed input conflicts", async () => {
    const f = fixture();
    try {
      const input = {
        actor: {
          kind: "MEMBER" as const,
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      };
      expect((await f.authority.mutateAsMember(f.connector, input)).ok).toBe(true);
      expect((await f.authority.mutateAsMember(f.connector, input)).ok).toBe(true);
      expect(f.calls()).toBe(1);
      const conflict = await f.authority.mutateAsMember(f.connector, {
        ...input,
        command: { ...f.command, mutation: { kind: "SET_TITLE", title: "Different" } },
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      f.database.close();
    }
  });

  test("recovers a provider-applied write after restart by exact non-secret marker", async () => {
    const f = fixture();
    const remote: Observed<Projection>[] = [];
    const connector: SourceConnector<string, Projection, Mutation> = {
      ...f.connector,
      async mutate(authorization, command) {
        const result = await f.connector.mutate(authorization, command);
        if (result.ok) remote.push(result.value);
        throw new Error("simulated lost provider response");
      },
      async *scan() {
        for (const observed of remote) {
          yield {
            ok: true,
            value: {
              projectId: observed.provenance.projectId,
              connectorId: observed.provenance.connectorId,
              connectorEpoch: observed.provenance.connectorEpoch,
              idempotencyKey: "provider_event_1",
              reference: observed.reference,
              actionMarker: "SET_TITLE:issue_42:mutation_1",
              mutationProof: {
                actionMarker: "SET_TITLE:issue_42:mutation_1",
                operation: "SET_TITLE",
                actionDigest: digest as never,
                precondition: {
                  kind: "EXACT_REVISION",
                  sourceRevision: "etag-1",
                  comparableDigest: digest as never,
                },
              },
              sourceRevision: observed.sourceRevision,
              comparableDigest: observed.comparableDigest,
              observedAt: observed.observedAt,
              freshness: observed.freshness,
              provenance: { kind: "MUTATION_CONFIRMATION" },
              value: observed.value,
            },
          };
        }
      },
    };
    try {
      const initial = await f.authority.mutateAsMember(connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      expect(initial.ok).toBe(false);
      const intent = f.database
        .query<{ id: string; state: string }, []>(
          "SELECT id, state FROM connector_operation_intents",
        )
        .get();
      expect(intent?.state).toBe("PENDING");
      const recovered = await f.restart().recoverPending(connector, {
        intentId: intent?.id ?? "missing",
      });
      expect(recovered.ok).toBe(true);
      expect(
        f.database
          .query<{ state: string }, []>("SELECT state FROM connector_operation_intents")
          .get()?.state,
      ).toBe("COMMITTED");
    } finally {
      f.database.close();
    }
  });

  test("does not recover a lost response from an unrelated event for the same reference", async () => {
    const f = fixture();
    const connector: SourceConnector<string, Projection, Mutation> = {
      ...f.connector,
      async mutate() {
        throw new Error("lost response");
      },
      async *scan() {
        yield {
          ok: true,
          value: {
            projectId: "project_1" as never,
            connectorId: "connector_1" as never,
            connectorEpoch: 1,
            idempotencyKey: "unrelated_event",
            reference: "issue_42",
            sourceRevision: "etag-unrelated",
            comparableDigest: "e".repeat(64) as never,
            observedAt: 100,
            freshness: "FRESH" as const,
            provenance: { kind: "MUTATION_CONFIRMATION" as const },
            value: { title: "Unrelated" },
          },
        };
      },
    };
    try {
      await f.authority.mutateAsMember(connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      const intentId = f.database
        .query<{ id: string }, []>("SELECT id FROM connector_operation_intents")
        .get()?.id;
      const recovered = await f.restart().recoverPending(connector, {
        intentId: intentId ?? "missing",
      });
      expect(recovered.ok).toBe(false);
      if (!recovered.ok) expect(recovered.error.code).toBe("CONNECTOR_OPERATION_PENDING");
    } finally {
      f.database.close();
    }
  });

  test("confirmation rollback leaves the generic intent recoverable", async () => {
    let fail = true;
    const f = fixture({
      beforeConfirmationCommit: () => {
        if (fail) throw new Error("injected confirmation rollback");
      },
    });
    try {
      const result = await f.authority.mutateAsMember(f.connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      expect(result.ok).toBe(false);
      expect(
        f.database
          .query<{ state: string }, []>("SELECT state FROM connector_operation_intents")
          .get()?.state,
      ).toBe("PENDING");
      fail = false;
    } finally {
      f.database.close();
    }
  });

  test("revocation before recovery requires reauthorization and never auto-resumes", async () => {
    const f = fixture();
    const connector: SourceConnector<string, Projection, Mutation> = {
      ...f.connector,
      async mutate() {
        throw new Error("lost response");
      },
      async *scan() {
        yield* [];
      },
    };
    try {
      await f.authority.mutateAsMember(connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      f.database.exec(
        "UPDATE connector_epochs SET epoch = 2, review_state = 'REVOKED', revision = revision + 1 WHERE connector_id = 'connector_1'",
      );
      const intentId = f.database
        .query<{ id: string }, []>("SELECT id FROM connector_operation_intents")
        .get()?.id;
      const recovered = await f.restart().recoverPending(connector, {
        intentId: intentId ?? "missing",
      });
      expect(recovered.ok).toBe(false);
      if (!recovered.ok) expect(recovered.error.code).toBe("CONNECTOR_REAUTHORIZATION_REQUIRED");
      expect(
        f.database
          .query<{ state: string }, []>("SELECT state FROM connector_operation_intents")
          .get()?.state,
      ).toBe("REQUIRES_REAUTHORIZATION");
    } finally {
      f.database.close();
    }
  });

  test("ambiguous marker recovery fails permanently without applying a projection", async () => {
    const f = fixture();
    const connector: SourceConnector<string, Projection, Mutation> = {
      ...f.connector,
      async mutate() {
        throw new Error("lost response");
      },
      async *scan() {
        for (const [index, reference] of ["issue_42", "issue_42"].entries()) {
          yield {
            ok: true,
            value: {
              projectId: "project_1" as never,
              connectorId: "connector_1" as never,
              connectorEpoch: 1,
              idempotencyKey: `event_${index + 1}`,
              reference,
              actionMarker: "SET_TITLE:issue_42:mutation_1",
              mutationProof: {
                actionMarker: "SET_TITLE:issue_42:mutation_1",
                operation: "SET_TITLE",
                actionDigest: digest as never,
                precondition: {
                  kind: "EXACT_REVISION",
                  sourceRevision: "etag-1",
                  comparableDigest: digest as never,
                },
              },
              sourceRevision: "etag-2",
              comparableDigest: "b".repeat(64) as never,
              observedAt: 100,
              freshness: "FRESH",
              provenance: { kind: "MUTATION_CONFIRMATION" },
              value: { title: "Updated" },
            },
          };
        }
      },
    };
    try {
      await f.authority.mutateAsMember(connector, {
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        reference: "issue_42",
        operation: "SET_TITLE",
        command: f.command,
      });
      const intentId = f.database
        .query<{ id: string }, []>("SELECT id FROM connector_operation_intents")
        .get()?.id;
      const recovered = await f.restart().recoverPending(connector, {
        intentId: intentId ?? "missing",
      });
      expect(recovered.ok).toBe(false);
      if (!recovered.ok) expect(recovered.error.code).toBe("CONNECTOR_RECOVERY_AMBIGUOUS");
      expect(
        f.database
          .query<{ state: string }, []>("SELECT state FROM connector_operation_intents")
          .get()?.state,
      ).toBe("FAILED_PERMANENT");
    } finally {
      f.database.close();
    }
  });

  test("run-independent reconciliation is revisioned, idempotent, and body-safe", () => {
    const f = fixture();
    try {
      const event = {
        projectId: "project_1" as never,
        connectorId: "connector_1" as never,
        connectorEpoch: 1,
        idempotencyKey: "reconcile_1",
        reference: "issue_42",
        sourceRevision: "etag-3",
        comparableDigest: "c".repeat(64) as never,
        observedAt: 200,
        freshness: "FRESH" as const,
        provenance: { kind: "RECONCILIATION" as const },
        value: { title: "Reconciled" },
      };
      const first = f.authority.reconcileSource(event);
      expect(first.ok).toBe(true);
      const replay = f.authority.reconcileSource(event);
      expect(replay.ok).toBe(true);
      const later = f.authority.reconcileSource({
        ...event,
        idempotencyKey: "reconcile_2",
        sourceRevision: "etag-4",
        comparableDigest: "d".repeat(64) as never,
        value: { title: "Later" },
      });
      expect(later.ok).toBe(true);
      const immutableReplay = f.authority.reconcileSource(event);
      expect(immutableReplay.ok).toBe(true);
      if (immutableReplay.ok) {
        expect(immutableReplay.value.value).toEqual({ title: "Reconciled" });
        expect(immutableReplay.value.sourceRevision).toBe("etag-3");
        expect(immutableReplay.auditId).toBe(first.ok ? first.auditId : undefined);
      }
      const conflict = f.authority.reconcileSource({
        ...event,
        value: { title: "Changed input" },
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
      const bodyLeak = f.authority.reconcileSource({
        ...event,
        idempotencyKey: "reconcile_body",
        value: { title: "Safe", body: "private body must not persist" } as never,
      });
      expect(bodyLeak.ok).toBe(false);
      expect(new TextDecoder().decode(f.database.serialize())).not.toContain(
        "private body must not persist",
      );
    } finally {
      f.database.close();
    }
  });
});
