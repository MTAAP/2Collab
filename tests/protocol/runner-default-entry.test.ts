import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunnerControlSocket } from "../../src/server/adapters/wss/bun-runner-control.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("default entry boots composed Task6 auth and exchanges authenticated runner traffic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-default-runner-"));
  directories.push(directory);
  const prior = {
    DATA_DIR: Bun.env.DATA_DIR,
    NODE_ENV: Bun.env.NODE_ENV,
    RUNNER_COMPOSITION_MODULE: Bun.env.RUNNER_COMPOSITION_MODULE,
  };
  Bun.env.DATA_DIR = directory;
  Bun.env.NODE_ENV = "test";
  Bun.env.RUNNER_COMPOSITION_MODULE = pathToFileURL(
    join(import.meta.dir, "../fixtures/production-runner-composition.ts"),
  ).href;
  try {
    const loaded = await import(
      `${pathToFileURL(join(import.meta.dir, "../../src/server/index.ts")).href}?entry=${Date.now()}`
    );
    const server = loaded.default;
    const now = Math.floor(Date.now() / 1_000);
    const proof = "member-proof-with-at-least-thirty-two-bytes";
    const proofHash = createHash("sha256").update(proof).digest("hex");
    server.database.exec(`
      INSERT INTO deployments(id, singleton, team_id, revision, created_at)
        VALUES ('deployment_1', 1, 'team_1', 1, ${now});
      INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
        VALUES ('member_1', 'Ada', 'OWNER', 'ACTIVE', 1, 1, ${now});
      INSERT INTO sessions(
        id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
        absolute_expires_at, member_authority_epoch, revision, created_at
      ) VALUES (
        'session_1', 'member_1', X'${proofHash}', 'BROWSER', ${now + 3600}, ${now + 3600},
        zeroblob(32), ${now + 3600}, 1, 1, ${now}
      );
      INSERT INTO device_credential_families(
        id, member_id, device_id, sender_key_thumbprint, current_refresh_hash,
        member_authority_epoch, revision, created_at, idle_expires_at, absolute_expires_at
      ) VALUES (
        'family_1', 'member_1', 'device_1', 'device_thumb_1', X'${"31".repeat(32)}',
        1, 1, ${now}, ${now + 3600}, ${now + 3600}
      );
    `);
    const begun = await server.runnerRegistry.beginPairing({
      idempotencyKey: "pair_begin_1",
      principal: {
        kind: "VERIFIED_DEVICE",
        memberId: "member_1",
        memberAuthorityEpoch: 1,
        deviceFamilyId: "family_1",
        deviceId: "device_1",
        senderKeyThumbprint: "device_thumb_1",
        expiresAt: now + 3600,
      },
    } as never);
    if (!begun.ok) throw new Error(begun.error.code);
    const confirmed = await server.runnerRegistry.confirmPairing({
      idempotencyKey: "pair_confirm_1",
      actor: { kind: "MEMBER", memberId: "member_1", sessionId: "session_1", sessionProof: proof },
      pairingId: begun.value.pairingId,
    } as never);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    const paired = await server.runnerRegistry.consumePairing({
      idempotencyKey: "pair_consume_1",
      pairingSecret: begun.value.pairingSecret,
      keyId: "key_1",
      keyProof: "new:key_1",
    } as never);
    if (!paired.ok) throw new Error(paired.error.code);
    const access = await server.runnerAuthentication.exchangeCredential({
      runnerCredential: paired.value.runnerCredential,
      keyProof: `possession:${paired.value.keyThumbprint}`,
    });
    if (!access.ok) throw new Error(access.error.code);

    let upgradeData: unknown;
    const response = await server.fetch(
      new Request("https://collab.test/runner/v1", {
        headers: {
          authorization: `DPoP ${access.value.accessToken}`,
          dpop: "dpop:jti_default_1",
          "dpop-nonce": access.value.nonce,
        },
      }),
      {
        upgrade(_request: Request, options: { data: unknown }) {
          upgradeData = options.data;
          return true;
        },
      },
    );
    expect(response).toBeUndefined();
    const socket = {
      data: upgradeData,
      sent: [] as string[],
      closes: [] as Array<readonly [number, string]>,
      send(value: string) {
        this.sent.push(value);
        return Buffer.byteLength(value, "utf8");
      },
      close(code: number, reason: string) {
        this.closes.push([code, reason]);
      },
      getBufferedAmount: () => 0,
    } satisfies RunnerControlSocket & { sent: string[]; closes: Array<readonly [number, string]> };
    server.websocket.open(socket);
    server.websocket.message(
      socket,
      JSON.stringify({
        kind: "CLIENT_HELLO",
        ranges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
      }),
    );
    server.websocket.message(
      socket,
      JSON.stringify({
        protocolVersion: "1.0",
        messageId: "runner_message_1",
        sequence: 1,
        issuedAt: now,
        expiresAt: now + 10,
        body: { kind: "HEARTBEAT", repositoryObservations: [] },
      }),
    );
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(socket.sent.map((wire) => JSON.parse(wire).kind ?? JSON.parse(wire).body.kind)).toEqual([
      "SERVER_WELCOME",
      "HEARTBEAT_ACK",
    ]);
    expect(socket.closes).toEqual([]);
    expect(await Bun.file(join(directory, "collab.sqlite")).exists()).toBeTrue();
    expect(await Bun.file(join(directory, "collab.db")).exists()).toBeFalse();
    server.database.close();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
});

test("default entry refuses an incomplete restore before composition or database startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-incomplete-restore-"));
  directories.push(directory);
  await writeFile(join(directory, ".2collab-restore-incomplete"), "restore_1\n", {
    mode: 0o600,
  });
  const entry = pathToFileURL(join(import.meta.dir, "../../src/server/index.ts")).href;
  const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(entry)})`], {
    env: {
      ...process.env,
      DATA_DIR: directory,
      NODE_ENV: "test",
      RUNNER_COMPOSITION_MODULE: pathToFileURL(join(directory, "must-not-import.ts")).href,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("RESTORE_INCOMPLETE");
  expect(stderr).not.toContain("must-not-import.ts");
  expect(await Bun.file(join(directory, "collab.sqlite")).exists()).toBeFalse();
  expect(await Bun.file(join(directory, "collab.sqlite-wal")).exists()).toBeFalse();
  expect(await Bun.file(join(directory, ".2collab-restore-incomplete")).text()).toBe("restore_1\n");
});
