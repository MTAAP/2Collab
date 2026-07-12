import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { inImmediateTransaction } from "../../../db/transaction.ts";

const Begin = z
  .object({
    bootstrapSecret: z.string().min(32).max(512),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();
const Complete = z.object({ registrationContext: z.string().min(32).max(512) }).strict();

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function createBetterAuthBootstrapRoutes(
  input: Readonly<{
    database: Database;
    configuredOrigin: string;
    bootstrapSecret: string;
    clock: () => number;
    id: (prefix: string) => string;
    safeEqual: (left: string, right: string) => boolean;
  }>,
) {
  const app = new Hono();
  const json = async (request: Request) => {
    if (
      request.headers.get("origin") !== input.configuredOrigin ||
      request.headers.get("sec-fetch-site") !== "same-origin" ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
    )
      return null;
    try {
      return await request.json();
    } catch {
      return null;
    }
  };

  app.post("/bootstrap/auth/begin", async (context) => {
    const parsed = Begin.safeParse(await json(context.req.raw));
    if (!parsed.success || !input.safeEqual(parsed.data.bootstrapSecret, input.bootstrapSecret))
      return context.json(
        {
          error: {
            code: "BOOTSTRAP_INVALID",
            message: "Bootstrap authorization is invalid.",
          },
        },
        403,
      );
    if (
      input.database.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get()
        ?.count
    )
      return context.json(
        {
          error: {
            code: "BOOTSTRAP_CONSUMED",
            message: "Deployment bootstrap is complete.",
          },
        },
        409,
      );
    const registrationContext = randomBytes(32).toString("base64url");
    const memberId = input.id("member");
    const ticketId = input.id("auth_registration");
    const now = input.clock();
    try {
      inImmediateTransaction(input.database, () => {
        if (
          input.database
            .query<{ count: number }, []>("SELECT count(*) AS count FROM deployments")
            .get()?.count
        )
          throw new Error("BOOTSTRAP_CONSUMED");
        input.database
          .query(
            `INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
             VALUES (?, ?, ?, 0, ?, ?)`,
          )
          .run(
            memberId,
            parsed.data.displayName,
            `${memberId}@identity.invalid`,
            now * 1_000,
            now * 1_000,
          );
        input.database
          .query(
            `INSERT INTO auth_registration_tickets(
               id, secret_hash, auth_user_id, intended_member_id, display_name,
               purpose, state, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, 'BOOTSTRAP', 'PENDING', ?, ?)`,
          )
          .run(
            ticketId,
            digest(registrationContext),
            memberId,
            memberId,
            parsed.data.displayName,
            now,
            now + 300,
          );
        input.database
          .query(
            `INSERT INTO audit_events(
               id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
             ) VALUES (?, 'BOOTSTRAP_AUTH_BEGUN', 'HOST', 'BOOTSTRAP', ?, ?, ?)`,
          )
          .run(
            input.id("audit"),
            memberId,
            JSON.stringify({ disposition: "BEGUN", expiresInSeconds: 300 }),
            now,
          );
      });
      return context.json({
        ok: true,
        value: { registrationContext, memberId, expiresAt: now + 300 },
      });
    } catch (error) {
      return context.json(
        {
          error: {
            code:
              error instanceof Error && error.message === "BOOTSTRAP_CONSUMED"
                ? "BOOTSTRAP_CONSUMED"
                : "BOOTSTRAP_FAILED",
            message: "Deployment bootstrap failed.",
          },
        },
        409,
      );
    }
  });

  app.post("/bootstrap/auth/complete", async (context) => {
    const parsed = Complete.safeParse(await json(context.req.raw));
    if (!parsed.success)
      return context.json(
        {
          error: {
            code: "BOOTSTRAP_INVALID",
            message: "Bootstrap authorization is invalid.",
          },
        },
        400,
      );
    const ticket = input.database
      .query<
        {
          id: string;
          auth_user_id: string;
          intended_member_id: string;
          display_name: string;
        },
        [Uint8Array, number]
      >(
        `SELECT id, auth_user_id, intended_member_id, display_name
         FROM auth_registration_tickets
         WHERE secret_hash = ? AND purpose = 'BOOTSTRAP' AND state = 'PASSKEY_VERIFIED'
           AND consumed_at IS NULL AND expires_at > ?
           AND EXISTS(
             SELECT 1 FROM auth_passkeys
             WHERE userId = auth_user_id AND createdAt >= auth_registration_tickets.created_at * 1000
           )`,
      )
      .get(digest(parsed.data.registrationContext), input.clock());
    if (!ticket)
      return context.json(
        {
          error: {
            code: "BOOTSTRAP_INVALID",
            message: "Bootstrap authorization is invalid.",
          },
        },
        400,
      );
    const now = input.clock();
    try {
      const result = inImmediateTransaction(input.database, () => {
        if (
          input.database
            .query<{ count: number }, []>("SELECT count(*) AS count FROM deployments")
            .get()?.count
        )
          return null;
        const consumed = input.database
          .query(
            `UPDATE auth_registration_tickets SET state = 'CONSUMED', consumed_at = ?
             WHERE id = ? AND state = 'PASSKEY_VERIFIED' AND consumed_at IS NULL AND expires_at > ?`,
          )
          .run(now, ticket.id, now);
        if (consumed.changes !== 1) return null;
        input.database
          .query(
            `INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
             VALUES (?, ?, 'OWNER', 'ACTIVE', 1, 1, ?)`,
          )
          .run(ticket.intended_member_id, ticket.display_name, now);
        input.database
          .query(
            `INSERT INTO auth_member_links(
               auth_user_id, member_id, authority_epoch_snapshot, created_at
             ) VALUES (?, ?, 1, ?)`,
          )
          .run(ticket.auth_user_id, ticket.intended_member_id, now);
        const deploymentId = input.id("deployment");
        input.database
          .query(
            "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES (?, 1, ?, 1, ?)",
          )
          .run(deploymentId, input.id("team"), now);
        input.database
          .query(
            `INSERT INTO deployment_authority_state(
               deployment_id, singleton, authority_incarnation, restore_state,
               revision, created_at, updated_at
             ) VALUES (?, 1, ?, 'READY', 1, ?, ?)`,
          )
          .run(deploymentId, randomBytes(32).toString("hex"), now, now);
        input.database
          .query(
            `INSERT INTO audit_events(
               id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
             ) VALUES (?, 'BOOTSTRAP_AUTH_COMPLETED', 'MEMBER', ?, ?, ?, ?)`,
          )
          .run(
            input.id("audit"),
            ticket.intended_member_id,
            ticket.intended_member_id,
            JSON.stringify({ disposition: "CONSUMED", role: "OWNER" }),
            now,
          );
        return { memberId: ticket.intended_member_id };
      });
      return result
        ? context.json({
            ok: true,
            value: { ...result, readyToSignIn: true as const },
          })
        : context.json(
            {
              error: {
                code: "BOOTSTRAP_CONSUMED",
                message: "Deployment bootstrap is complete.",
              },
            },
            409,
          );
    } catch {
      return context.json(
        {
          error: {
            code: "BOOTSTRAP_FAILED",
            message: "Deployment bootstrap failed.",
          },
        },
        409,
      );
    }
  });

  app.post("/auth/recovery/complete", async (context) => {
    const parsed = Complete.safeParse(await json(context.req.raw));
    if (!parsed.success)
      return context.json(
        {
          error: {
            code: "HOST_RECOVERY_INVALID",
            message: "Host recovery is invalid.",
          },
        },
        400,
      );
    const now = input.clock();
    const ticket = input.database
      .query<
        { id: string; auth_user_id: string; intended_member_id: string },
        [Uint8Array, number]
      >(
        `SELECT id, auth_user_id, intended_member_id
         FROM auth_registration_tickets
         WHERE secret_hash = ? AND purpose = 'HOST_RECOVERY' AND state = 'PASSKEY_VERIFIED'
           AND consumed_at IS NULL AND expires_at > ?
           AND EXISTS(
             SELECT 1 FROM auth_passkeys
             WHERE userId = auth_user_id AND createdAt >= auth_registration_tickets.created_at * 1000
           )`,
      )
      .get(digest(parsed.data.registrationContext), now);
    if (!ticket)
      return context.json(
        {
          error: {
            code: "HOST_RECOVERY_INVALID",
            message: "Host recovery is invalid.",
          },
        },
        400,
      );
    try {
      const consumed = inImmediateTransaction(input.database, () => {
        const result = input.database
          .query(
            `UPDATE auth_registration_tickets SET state = 'CONSUMED', consumed_at = ?
             WHERE id = ? AND state = 'PASSKEY_VERIFIED' AND consumed_at IS NULL
               AND expires_at > ?`,
          )
          .run(now, ticket.id, now);
        if (result.changes !== 1) return false;
        input.database
          .query(
            `INSERT INTO audit_events(
               id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
             ) VALUES (?, 'HOST_RECOVERY_COMPLETED', 'MEMBER', ?, ?, ?, ?)`,
          )
          .run(
            input.id("audit"),
            ticket.intended_member_id,
            ticket.intended_member_id,
            JSON.stringify({
              disposition: "CONSUMED",
              passkeysPreserved: true,
              sessionsPreserved: true,
            }),
            now,
          );
        return true;
      });
      return consumed
        ? context.json({
            ok: true,
            value: {
              memberId: ticket.intended_member_id,
              readyToSignIn: true as const,
            },
          })
        : context.json(
            {
              error: {
                code: "HOST_RECOVERY_INVALID",
                message: "Host recovery is invalid.",
              },
            },
            400,
          );
    } catch {
      return context.json(
        {
          error: {
            code: "HOST_RECOVERY_FAILED",
            message: "Host recovery failed.",
          },
        },
        409,
      );
    }
  });

  return app;
}
