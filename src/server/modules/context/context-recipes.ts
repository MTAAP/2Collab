import type {
  ContextCategory,
  ContextOmissionReason,
  ReferenceFirstBootstrapEnvelope,
} from "../../../shared/contracts/context.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

export type PredecessorContextPolicy = "NONE" | "LATEST_CHECKPOINT" | "VERIFIED_EVIDENCE";

export type ContextRecipeVersion = Readonly<{
  id: string;
  version: number;
  projectId: string;
  digest: string;
  perCategoryLimits: Readonly<Partial<Record<ContextCategory, number>>>;
  maximumReferences: number;
  maximumPreviewBytes: number;
  freshnessSeconds: number;
  predecessorPolicy: PredecessorContextPolicy;
}>;

export type AuthorizedContextCandidate = Readonly<{
  category: ContextCategory;
  referenceId: string;
  canonicalKey: string;
  observedRevision: string;
  observedAt: number;
  availability: "AVAILABLE" | "UNAVAILABLE";
  authority: "AUTHORIZED" | "FORBIDDEN";
  priority: number;
  authoredPreview?: string;
}>;

function invalidRecipe(): Result<never> {
  return {
    ok: false,
    error: {
      code: "CONTEXT_RECIPE_INVALID",
      message: "The context recipe is invalid.",
      retry: "NEVER",
    },
  };
}

function invalidCandidate(): Result<never> {
  return {
    ok: false,
    error: {
      code: "CONTEXT_CANDIDATE_INVALID",
      message: "The context candidate is invalid.",
      retry: "NEVER",
    },
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoder = new TextEncoder();
  let result = "";
  let used = 0;
  for (const codePoint of value) {
    const bytes = encoder.encode(codePoint).byteLength;
    if (used + bytes > maximumBytes) break;
    result += codePoint;
    used += bytes;
  }
  return result;
}

function omission(
  candidate: AuthorizedContextCandidate,
  reason: ContextOmissionReason,
): ReferenceFirstBootstrapEnvelope["omissions"][number] {
  return { category: candidate.category, referenceId: candidate.referenceId, reason };
}

function isRecipeShapeValid(recipe: ContextRecipeVersion): boolean {
  return (
    recipe.id.length > 0 &&
    recipe.id.length <= 128 &&
    recipe.projectId.length > 0 &&
    recipe.version > 0 &&
    Number.isInteger(recipe.version) &&
    /^[a-f0-9]{64}$/.test(recipe.digest) &&
    Number.isInteger(recipe.maximumReferences) &&
    recipe.maximumReferences > 0 &&
    recipe.maximumReferences <= 64 &&
    Number.isInteger(recipe.maximumPreviewBytes) &&
    recipe.maximumPreviewBytes >= 0 &&
    recipe.maximumPreviewBytes <= 65_536 &&
    Number.isInteger(recipe.freshnessSeconds) &&
    recipe.freshnessSeconds > 0 &&
    Object.values(recipe.perCategoryLimits).every(
      (limit) => Number.isInteger(limit) && limit >= 0 && limit <= 64,
    ) &&
    Object.keys(recipe.perCategoryLimits).every((category) =>
      [
        "COORDINATION",
        "SOURCE",
        "REPOSITORY",
        "PUBLISHED_GIT_REFERENCE",
        "INSTRUCTION",
        "CHECKPOINT",
        "EVIDENCE",
        "GATE",
      ].includes(category),
    ) &&
    ["NONE", "LATEST_CHECKPOINT", "VERIFIED_EVIDENCE"].includes(recipe.predecessorPolicy)
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeContextRecipeDigest(recipe: Omit<ContextRecipeVersion, "digest">): string {
  return createHash("sha256").update(canonical(recipe), "utf8").digest("hex");
}

function isRecipeValid(recipe: ContextRecipeVersion): boolean {
  const { digest, ...unsigned } = recipe;
  return isRecipeShapeValid(recipe) && digest === computeContextRecipeDigest(unsigned);
}

export function assembleBootstrapEnvelope(
  recipe: ContextRecipeVersion,
  candidates: readonly AuthorizedContextCandidate[],
  now: number,
): Result<ReferenceFirstBootstrapEnvelope> {
  if (!isRecipeValid(recipe) || !Number.isInteger(now) || now < 0 || candidates.length > 4_096) {
    return invalidRecipe();
  }
  if (
    candidates.some(
      (candidate) =>
        ![
          "COORDINATION",
          "SOURCE",
          "REPOSITORY",
          "PUBLISHED_GIT_REFERENCE",
          "INSTRUCTION",
          "CHECKPOINT",
          "EVIDENCE",
          "GATE",
        ].includes(candidate.category) ||
        candidate.referenceId.length === 0 ||
        candidate.referenceId.length > 256 ||
        candidate.canonicalKey.length === 0 ||
        candidate.canonicalKey.length > 512 ||
        candidate.observedRevision.length === 0 ||
        candidate.observedRevision.length > 128 ||
        !Number.isSafeInteger(candidate.observedAt) ||
        candidate.observedAt < 0 ||
        !Number.isSafeInteger(candidate.priority) ||
        !["AVAILABLE", "UNAVAILABLE"].includes(candidate.availability) ||
        !["AUTHORIZED", "FORBIDDEN"].includes(candidate.authority) ||
        (candidate.authoredPreview !== undefined &&
          Buffer.byteLength(candidate.authoredPreview, "utf8") > 65_536),
    )
  ) {
    return invalidCandidate();
  }

  const omissions: Array<ReferenceFirstBootstrapEnvelope["omissions"][number]> = [];
  const eligible: AuthorizedContextCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.authority !== "AUTHORIZED") {
      omissions.push(omission(candidate, "FORBIDDEN"));
      continue;
    }
    if (candidate.availability !== "AVAILABLE") {
      omissions.push(omission(candidate, "UNAVAILABLE"));
      continue;
    }
    eligible.push(candidate);
  }

  eligible.sort(
    (left, right) =>
      right.priority - left.priority ||
      right.observedAt - left.observedAt ||
      left.canonicalKey.localeCompare(right.canonicalKey) ||
      left.referenceId.localeCompare(right.referenceId),
  );

  const deduplicated: AuthorizedContextCandidate[] = [];
  const seenKeys = new Set<string>();
  const seenDurableReferences = new Set<string>();
  for (const candidate of eligible) {
    const durableReference = `${candidate.category}\u0000${candidate.referenceId}`;
    if (seenKeys.has(candidate.canonicalKey) || seenDurableReferences.has(durableReference)) {
      omissions.push(omission(candidate, "DUPLICATE"));
      continue;
    }
    seenKeys.add(candidate.canonicalKey);
    seenDurableReferences.add(durableReference);
    deduplicated.push(candidate);
  }

  const categoryCounts = new Map<ContextCategory, number>();
  const selected: AuthorizedContextCandidate[] = [];
  for (const candidate of deduplicated) {
    const categoryCount = categoryCounts.get(candidate.category) ?? 0;
    if (categoryCount >= (recipe.perCategoryLimits[candidate.category] ?? 0)) {
      omissions.push(omission(candidate, "CATEGORY_LIMIT"));
      continue;
    }
    if (selected.length >= recipe.maximumReferences) {
      omissions.push(omission(candidate, "TOTAL_LIMIT"));
      continue;
    }
    categoryCounts.set(candidate.category, categoryCount + 1);
    selected.push(candidate);
  }

  let previewBytesRemaining = recipe.maximumPreviewBytes;
  const references = selected.map((candidate) => {
    const authoredPreview = candidate.authoredPreview
      ? truncateUtf8(candidate.authoredPreview, previewBytesRemaining)
      : undefined;
    if (authoredPreview)
      previewBytesRemaining -= new TextEncoder().encode(authoredPreview).byteLength;
    return {
      category: candidate.category,
      referenceId: candidate.referenceId,
      observedRevision: candidate.observedRevision,
      status:
        now - candidate.observedAt <= recipe.freshnessSeconds
          ? ("FRESH" as const)
          : ("STALE" as const),
      ...(authoredPreview ? { authoredPreview } : {}),
    };
  });
  const selectedReferenceKeys = new Set(
    references.map((reference) => `${reference.category}\u0000${reference.referenceId}`),
  );
  const durableOmissions = omissions.filter(
    (item) =>
      item.reason !== "DUPLICATE" ||
      !selectedReferenceKeys.has(`${item.category}\u0000${item.referenceId}`),
  );

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      contextRecipe: { id: recipe.id, version: recipe.version, digest: recipe.digest },
      references,
      omissions: durableOmissions,
    },
  };
}

type RecipeRow = Readonly<{
  id: string;
  project_id: string;
  display_name: string;
  current_version: number;
  state: "ACTIVE" | "ARCHIVED";
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}>;

export type ContextRecipeRecord = Readonly<{
  id: string;
  projectId: string;
  displayName: string;
  currentVersion: number;
  state: "ACTIVE" | "ARCHIVED";
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}>;

function recipeRecord(row: RecipeRow): ContextRecipeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    displayName: row.display_name,
    currentVersion: row.current_version,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  };
}

function contextError<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function activeMember(database: Database, memberId: string): boolean {
  return Boolean(
    database
      .query<{ present: number }, [string]>(
        "SELECT 1 AS present FROM members WHERE id = ? AND status = 'ACTIVE'",
      )
      .get(memberId),
  );
}

function readRecipe(database: Database, id: string, projectId?: string): RecipeRow | null {
  return (
    database
      .query<RecipeRow, [string, string | null, string | null]>(
        `SELECT id, project_id, display_name, current_version, state, revision,
                created_at, updated_at, archived_at
         FROM context_recipes WHERE id = ? AND (? IS NULL OR project_id = ?)`,
      )
      .get(id, projectId ?? null, projectId ?? null) ?? null
  );
}

function insertRecipeVersion(
  database: Database,
  version: ContextRecipeVersion,
  createdAt: number,
): void {
  const normalized = {
    ...version,
    digest: computeContextRecipeDigest({ ...version, digest: undefined } as never),
  };
  const include = (category: ContextCategory) =>
    (normalized.perCategoryLimits[category] ?? 0) > 0 ? 1 : 0;
  database
    .query<
      void,
      [
        string,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        string,
        string,
        number,
      ]
    >(
      `INSERT INTO context_recipe_versions(
         recipe_id, version, include_goal, include_coordination, include_sources,
         include_repository, include_predecessor_evidence, maximum_references,
         maximum_preview_bytes, freshness_seconds, predecessor_policy, recipe_digest, created_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      normalized.id,
      normalized.version,
      include("COORDINATION"),
      include("SOURCE"),
      include("REPOSITORY") || include("INSTRUCTION") || include("PUBLISHED_GIT_REFERENCE"),
      normalized.predecessorPolicy === "NONE" ? 0 : 1,
      normalized.maximumReferences,
      normalized.maximumPreviewBytes,
      normalized.freshnessSeconds,
      normalized.predecessorPolicy,
      normalized.digest,
      createdAt,
    );
  Object.entries(normalized.perCategoryLimits)
    .filter((entry): entry is [ContextCategory, number] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([category, maximumReferences]) => {
      database
        .query<void, [string, number, string, number]>(
          `INSERT INTO context_recipe_category_limits(
             recipe_id, recipe_version, category, maximum_references
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(normalized.id, normalized.version, category, maximumReferences);
    });
}

function readRecipeVersion(
  database: Database,
  projectId: string,
  id: string,
  version: number,
): ContextRecipeVersion | null {
  const row = database
    .query<
      {
        recipe_id: string;
        version: number;
        project_id: string;
        maximum_references: number;
        maximum_preview_bytes: number;
        freshness_seconds: number;
        predecessor_policy: PredecessorContextPolicy;
        recipe_digest: string;
      },
      [string, string, number]
    >(
      `SELECT versions.recipe_id, versions.version, recipes.project_id,
              versions.maximum_references, versions.maximum_preview_bytes,
              versions.freshness_seconds, versions.predecessor_policy, versions.recipe_digest
       FROM context_recipe_versions AS versions
       JOIN context_recipes AS recipes ON recipes.id = versions.recipe_id
       WHERE recipes.project_id = ? AND versions.recipe_id = ? AND versions.version = ?`,
    )
    .get(projectId, id, version);
  if (!row) return null;
  const perCategoryLimits = Object.fromEntries(
    database
      .query<{ category: ContextCategory; maximum_references: number }, [string, number]>(
        `SELECT category, maximum_references FROM context_recipe_category_limits
         WHERE recipe_id = ? AND recipe_version = ? ORDER BY category`,
      )
      .all(id, version)
      .map((limit) => [limit.category, limit.maximum_references]),
  ) as Partial<Record<ContextCategory, number>>;
  return {
    id: row.recipe_id,
    version: row.version,
    projectId: row.project_id,
    digest: row.recipe_digest,
    perCategoryLimits,
    maximumReferences: row.maximum_references,
    maximumPreviewBytes: row.maximum_preview_bytes,
    freshnessSeconds: row.freshness_seconds,
    predecessorPolicy: row.predecessor_policy,
  };
}

export function createContextRecipeStore(
  dependencies: Readonly<{
    database: Database;
    clock: () => number;
  }>,
) {
  return {
    create(
      input: Readonly<{
        actorMemberId: string;
        id: string;
        projectId: string;
        displayName: string;
        version: ContextRecipeVersion;
      }>,
    ): Result<ContextRecipeRecord & Readonly<{ version: ContextRecipeVersion }>> {
      if (!activeMember(dependencies.database, input.actorMemberId)) {
        return contextError("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      if (
        input.id !== input.version.id ||
        input.projectId !== input.version.projectId ||
        input.version.version !== 1 ||
        input.displayName.trim() !== input.displayName ||
        input.displayName.length === 0 ||
        input.displayName.length > 120 ||
        !isRecipeShapeValid(input.version)
      ) {
        return invalidRecipe();
      }
      const normalized = {
        ...input.version,
        digest: computeContextRecipeDigest({ ...input.version, digest: undefined } as never),
      };
      try {
        return inImmediateTransaction(dependencies.database, () => {
          if (readRecipe(dependencies.database, input.id)) {
            return contextError("CONTEXT_RECIPE_ALREADY_EXISTS", "Context recipe already exists.");
          }
          const project = dependencies.database
            .query<{ present: number }, [string]>("SELECT 1 AS present FROM projects WHERE id = ?")
            .get(input.projectId);
          if (!project) return contextError("PROJECT_NOT_FOUND", "Project was not found.");
          const now = dependencies.clock();
          dependencies.database
            .query<void, [string, string, string, number, string, number, number, number]>(
              `INSERT INTO context_recipes(
                 id, project_id, display_name, current_version, state, revision, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(input.id, input.projectId, input.displayName, 1, "ACTIVE", 1, now, now);
          insertRecipeVersion(dependencies.database, normalized, now);
          const record = readRecipe(dependencies.database, input.id, input.projectId) as RecipeRow;
          return { ok: true as const, value: { ...recipeRecord(record), version: normalized } };
        });
      } catch {
        return contextError("CONTEXT_RECIPE_STORAGE_FAILED", "Context recipe could not be stored.");
      }
    },

    edit(
      input: Readonly<{
        actorMemberId: string;
        id: string;
        expectedRevision: number;
        version: ContextRecipeVersion;
      }>,
    ): Result<ContextRecipeRecord & Readonly<{ version: ContextRecipeVersion }>> {
      if (!activeMember(dependencies.database, input.actorMemberId)) {
        return contextError("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      const current = readRecipe(dependencies.database, input.id, input.version.projectId);
      if (!current)
        return contextError("CONTEXT_RECIPE_NOT_FOUND", "Context recipe was not found.");
      if (current.state === "ARCHIVED") {
        return contextError("CONTEXT_RECIPE_ARCHIVED", "Context recipe is archived.");
      }
      if (current.revision !== input.expectedRevision) {
        return {
          ok: false,
          error: {
            code: "CONTEXT_RECIPE_REVISION_CONFLICT",
            message: "Context recipe revision changed.",
            retry: "REFRESH",
          },
        };
      }
      if (
        input.version.id !== input.id ||
        input.version.version !== current.current_version + 1 ||
        !isRecipeShapeValid(input.version)
      ) {
        return invalidRecipe();
      }
      const normalized = {
        ...input.version,
        digest: computeContextRecipeDigest({ ...input.version, digest: undefined } as never),
      };
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const committed = readRecipe(dependencies.database, input.id, input.version.projectId);
          if (!committed || committed.revision !== input.expectedRevision) {
            return {
              ok: false as const,
              error: {
                code: "CONTEXT_RECIPE_REVISION_CONFLICT",
                message: "Context recipe revision changed.",
                retry: "REFRESH" as const,
              },
            };
          }
          const now = dependencies.clock();
          insertRecipeVersion(dependencies.database, normalized, now);
          dependencies.database
            .query<void, [number, number, number, string, number]>(
              `UPDATE context_recipes SET current_version = ?, revision = ?, updated_at = ?
               WHERE id = ? AND revision = ?`,
            )
            .run(normalized.version, committed.revision + 1, now, committed.id, committed.revision);
          const updated = readRecipe(
            dependencies.database,
            input.id,
            input.version.projectId,
          ) as RecipeRow;
          return { ok: true as const, value: { ...recipeRecord(updated), version: normalized } };
        });
      } catch {
        return contextError("CONTEXT_RECIPE_STORAGE_FAILED", "Context recipe could not be stored.");
      }
    },

    inspectVersion(projectId: string, id: string, version: number): Result<ContextRecipeVersion> {
      const value = readRecipeVersion(dependencies.database, projectId, id, version);
      return value
        ? { ok: true, value }
        : contextError("CONTEXT_RECIPE_NOT_FOUND", "Context recipe was not found.");
    },

    archive(
      input: Readonly<{
        actorMemberId: string;
        id: string;
        projectId: string;
        expectedRevision: number;
      }>,
    ): Result<ContextRecipeRecord> {
      if (!activeMember(dependencies.database, input.actorMemberId)) {
        return contextError("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const current = readRecipe(dependencies.database, input.id, input.projectId);
          if (!current) {
            return contextError("CONTEXT_RECIPE_NOT_FOUND", "Context recipe was not found.");
          }
          if (current.revision !== input.expectedRevision) {
            return {
              ok: false as const,
              error: {
                code: "CONTEXT_RECIPE_REVISION_CONFLICT",
                message: "Context recipe revision changed.",
                retry: "REFRESH" as const,
              },
            };
          }
          if (current.state === "ARCHIVED") {
            return { ok: true as const, value: recipeRecord(current) };
          }
          const now = dependencies.clock();
          dependencies.database
            .query<void, [string, number, number, number, string, number]>(
              `UPDATE context_recipes
               SET state = ?, revision = ?, updated_at = ?, archived_at = ?
               WHERE id = ? AND revision = ?`,
            )
            .run("ARCHIVED", current.revision + 1, now, now, current.id, current.revision);
          const updated = readRecipe(dependencies.database, input.id, input.projectId) as RecipeRow;
          return { ok: true as const, value: recipeRecord(updated) };
        });
      } catch {
        return contextError(
          "CONTEXT_RECIPE_STORAGE_FAILED",
          "Context recipe could not be archived.",
        );
      }
    },
  };
}

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
