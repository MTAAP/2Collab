import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ConnectorScopeSchema,
  createProjectionCodec,
  EphemeralObservedSchema,
  EphemeralSearchPageSchema,
  EphemeralSearchResultSchema,
  ExactRevisionMutationSchema,
  ObservedSchema,
  ScopedSearchSchema,
} from "../../../src/server/modules/connectors/contract.ts";
import {
  GitHubMutationKindSchema,
  OutlineMutationKindSchema,
} from "../../../src/shared/contracts/commands.ts";

const digest = "a".repeat(64);

describe("connector contract", () => {
  test("uses the one closed shared mutation vocabulary", () => {
    expect(GitHubMutationKindSchema.options).toEqual([
      "CREATE_ISSUE",
      "EDIT_ISSUE",
      "ADD_COMMENT",
      "SET_LABELS",
      "SET_ASSIGNEES",
      "SET_MILESTONE",
      "SET_ISSUE_STATE",
      "CREATE_MILESTONE",
      "EDIT_MILESTONE",
      "ADD_PROJECT_ITEM",
      "REMOVE_PROJECT_ITEM",
      "SET_PROJECT_FIELD",
      "MOVE_PROJECT_ITEM",
    ]);
    expect(OutlineMutationKindSchema.options).toEqual([
      "CREATE_DOCUMENT_AS_MEMBER",
      "EDIT_DOCUMENT_AS_MEMBER",
      "EDIT_DOCUMENT_AS_BOT",
      "APPLY_PROPOSAL_AS_MEMBER",
      "PROMOTE_WORKING_DOCUMENT",
      "ARCHIVE_WORKING_DOCUMENT",
    ]);
  });

  test("strictly separates provider revision, comparable digest, local revision, and provenance", () => {
    const schema = ObservedSchema(z.object({ title: z.string().max(120) }).strict());
    const value = {
      value: { title: "Current" },
      reference: "issue_42",
      sourceRevision: "etag-2",
      comparableDigest: digest,
      projectionRevision: 3,
      observedAt: 1_000,
      sourceUpdatedAt: 900,
      freshness: "FRESH",
      provenance: {
        projectId: "project_1",
        connectorId: "connector_1",
        connectorEpoch: 4,
        kind: "MUTATION_CONFIRMATION",
        providerActorId: "provider_actor_1",
      },
    } as const;
    expect(schema.parse(value)).toEqual(value);
    expect(schema.safeParse({ ...value, rawPayload: {} }).success).toBe(false);
    expect(schema.safeParse({ ...value, sourceRevision: "x".repeat(129) }).success).toBe(false);
  });

  test("keeps one outer exact-revision authority envelope", () => {
    const schema = ExactRevisionMutationSchema(
      z.object({ kind: z.literal("SET_TITLE"), title: z.string().max(120) }).strict(),
    );
    const value = {
      projectId: "project_1",
      connectorId: "connector_1",
      connectorEpoch: 4,
      idempotencyKey: "mutation_1",
      precondition: {
        kind: "EXACT_REVISION",
        sourceRevision: "etag-1",
        comparableDigest: digest,
      },
      actionDigest: digest,
      mutation: { kind: "SET_TITLE", title: "Updated" },
    } as const;
    expect(schema.parse(value)).toEqual(value);
    expect(
      schema.safeParse({
        ...value,
        mutation: { ...value.mutation, connectorEpoch: 4 },
      }).success,
    ).toBe(false);
  });

  test("requires explicit project, connector, epoch, reference, and operation allowlists", () => {
    expect(
      ConnectorScopeSchema.parse({
        projectId: "project_1",
        connectorId: "connector_1",
        connectorEpoch: 4,
        references: ["issue_42"],
        operations: ["SET_TITLE"],
      }),
    ).toEqual({
      projectId: "project_1",
      connectorId: "connector_1",
      connectorEpoch: 4,
      references: ["issue_42"],
      operations: ["SET_TITLE"],
    });
    expect(
      ConnectorScopeSchema.safeParse({
        projectId: "project_1",
        connectorId: "connector_1",
        connectorEpoch: 4,
        references: [],
        operations: ["*"],
      }).success,
    ).toBe(false);
  });

  test("keeps live context bodies type-distinct from persistable projections", () => {
    const live = EphemeralObservedSchema(
      z.object({ body: z.string().max(16_384), title: z.string().max(120) }).strict(),
    ).parse({
      value: { body: "private live body", title: "Title" },
      reference: "document_1",
      sourceRevision: "revision_1",
      observedAt: 1_000,
      freshness: "FRESH",
    });
    expect(live.persistence).toBe("EPHEMERAL_ONLY");

    const codec = createProjectionCodec(z.object({ title: z.string().max(120) }).strict());
    expect(codec.serialize({ title: live.value.title }).ok).toBe(true);
    expect(codec.serialize(live.value as never).ok).toBe(false);

    const search = ScopedSearchSchema.parse({
      query: "release plan",
      providerLimit: 2,
      resultLimit: 20,
      maximumTotalSnippetBytes: 64 * 1024,
      timeoutMs: 5_000,
    });
    expect(search.resultLimit).toBe(20);
    const result = EphemeralSearchResultSchema(z.string().max(128)).parse({
      reference: "document_1",
      title: "Release plan",
      snippet: "private live snippet",
      persistence: "EPHEMERAL_ONLY",
    });
    expect(codec.serialize(result as never).ok).toBe(false);
    const utf8Codec = createProjectionCodec(z.object({ title: z.string().max(100_000) }).strict());
    expect(utf8Codec.serialize({ title: "é".repeat(40_000) }).ok).toBe(false);
    expect(
      EphemeralSearchPageSchema(z.string().max(128)).parse({
        results: [result],
        partialFailureCount: 0,
        truncated: false,
        persistence: "EPHEMERAL_ONLY",
      }).results,
    ).toHaveLength(1);
    expect(
      ScopedSearchSchema.safeParse({
        query: "x".repeat(513),
        providerLimit: 17,
        resultLimit: 101,
        maximumTotalSnippetBytes: 10 * 1024 * 1024,
        timeoutMs: 60_000,
      }).success,
    ).toBe(false);
  });
});
