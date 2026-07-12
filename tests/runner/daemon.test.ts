import { describe, expect, test } from "bun:test";
import { createRunnerDaemon } from "../../src/runner/daemon.ts";

describe("runner daemon lifecycle", () => {
  test("reconciles local process truth before connecting and quiesces before close", async () => {
    const order: string[] = [];
    const daemon = createRunnerDaemon({
      reconcile: async () => {
        order.push("reconcile");
        return { ok: true, value: { reconciled: 2 } };
      },
      transport: {
        async start() {
          order.push("transport:start");
        },
        async quiesce(deadline) {
          order.push(`transport:quiesce:${deadline}`);
          return { closed: 1, pending: 3 };
        },
        async stop() {
          order.push("transport:stop");
        },
      },
      localState: {
        close() {
          order.push("state:close");
        },
      },
      clock: () => 1_000,
    });
    expect(await daemon.start()).toEqual({ ok: true, value: { state: "RUNNING", reconciled: 2 } });
    expect(await daemon.start()).toEqual({ ok: true, value: { state: "RUNNING", reconciled: 2 } });
    expect(order).toEqual(["reconcile", "transport:start"]);
    expect(await daemon.shutdown(5)).toEqual({
      ok: true,
      value: { state: "STOPPED", closedConnections: 1, pendingDeliveries: 3 },
    });
    expect(order).toEqual([
      "reconcile",
      "transport:start",
      "transport:quiesce:1005",
      "transport:stop",
      "state:close",
    ]);
  });

  test("fails closed before networking when local reconciliation fails", async () => {
    let starts = 0;
    const daemon = createRunnerDaemon({
      reconcile: async () => ({
        ok: false,
        error: {
          code: "PROCESS_RECONCILIATION_FAILED",
          message: "Reconcile failed.",
          retry: "NEVER",
        },
      }),
      transport: {
        async start() {
          starts += 1;
        },
        async quiesce() {
          return { closed: 0, pending: 0 };
        },
        async stop() {},
      },
      localState: { close() {} },
      clock: () => 0,
    });
    expect(await daemon.start()).toMatchObject({
      ok: false,
      error: { code: "PROCESS_RECONCILIATION_FAILED" },
    });
    expect(starts).toBe(0);
    expect(daemon.state).toBe("FAILED");
  });
});
