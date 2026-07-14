import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Result } from "../shared/contracts/result.ts";
import type { CustomLaunchProfile } from "./execution-contract.ts";

const ProfileDraftSchema = z
  .object({
    adapter: z.enum(["CLAUDE", "CODEX"]),
    executable: z.string().min(1).max(4_096),
    fixedArguments: z.array(z.string().min(1).max(4_096)).max(64),
    promptTransport: z
      .object({
        headless: z.enum(["STDIN", "ARGUMENT"]),
        interactive: z.enum(["TERMINAL_INPUT", "ARGUMENT"]),
      })
      .strict(),
    supportedInteractions: z
      .array(z.enum(["HEADLESS", "INTERACTIVE"]))
      .min(1)
      .max(2),
    environment: z
      .array(
        z.discriminatedUnion("source", [
          z
            .object({
              name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
              source: z.literal("LITERAL"),
              value: z.string().max(4_096),
            })
            .strict(),
          z
            .object({
              name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
              source: z.literal("OS_CREDENTIAL"),
              reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/),
            })
            .strict(),
        ]),
      )
      .max(32)
      .optional(),
  })
  .strict();

const ProfileSchema = ProfileDraftSchema.extend({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

type ProfileDraft = z.infer<typeof ProfileDraftSchema>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function canonical(draft: ProfileDraft): string {
  return JSON.stringify({
    adapter: draft.adapter,
    executable: draft.executable,
    fixedArguments: draft.fixedArguments,
    promptTransport: draft.promptTransport,
    supportedInteractions: [...new Set(draft.supportedInteractions)].sort(),
    environment: draft.environment
      ? [...draft.environment].sort((left, right) => left.name.localeCompare(right.name))
      : undefined,
  });
}

export function fingerprintLocalProfile(draft: Omit<CustomLaunchProfile, "fingerprint">): string {
  const parsed = ProfileDraftSchema.parse(draft);
  return createHash("sha256")
    .update("2collab-local-profile-v1\0", "utf8")
    .update(canonical(parsed), "utf8")
    .digest("hex");
}

export function createLocalProfileRegistry(database: Database, clock: () => number) {
  return {
    publish(
      profileId: string,
      profileVersionId: string,
      version: number,
      candidate: CustomLaunchProfile,
    ): Result<CustomLaunchProfile> {
      const profile = ProfileSchema.safeParse(candidate);
      if (
        !profile.success ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileVersionId) ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        fingerprintLocalProfile(
          (({ fingerprint: _fingerprint, ...draft }) => draft)(profile.data),
        ) !== profile.data.fingerprint
      ) {
        return failure("PROFILE_POLICY_DENIED", "Execution profile policy is invalid.");
      }
      try {
        database
          .query(
            `INSERT INTO local_profile_versions(
               id, profile_id, version, adapter, fingerprint, definition_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            profileVersionId,
            profileId,
            version,
            profile.data.adapter,
            profile.data.fingerprint,
            canonical(profile.data),
            clock(),
          );
        return { ok: true, value: profile.data };
      } catch {
        return failure("PROFILE_VERSION_CONFLICT", "Execution profile version already exists.");
      }
    },

    resolve(profileVersionId: string, expectedFingerprint: string): Result<CustomLaunchProfile> {
      const row = database
        .query<{ fingerprint: string; definition_json: string }, [string]>(
          "SELECT fingerprint, definition_json FROM local_profile_versions WHERE id = ?",
        )
        .get(profileVersionId);
      if (!row) return failure("PROFILE_UNAVAILABLE", "Execution profile is unavailable.");
      if (row.fingerprint !== expectedFingerprint) {
        return failure("PROFILE_VERSION_MISMATCH", "Execution profile version changed.");
      }
      let definition: unknown;
      try {
        definition = JSON.parse(row.definition_json);
      } catch {
        return failure("PROFILE_STORAGE_CORRUPT", "Execution profile storage is corrupt.");
      }
      const draft = ProfileDraftSchema.safeParse(definition);
      if (!draft.success || fingerprintLocalProfile(draft.data) !== row.fingerprint) {
        return failure("PROFILE_STORAGE_CORRUPT", "Execution profile storage is corrupt.");
      }
      return { ok: true, value: { ...draft.data, fingerprint: row.fingerprint } };
    },
  };
}
