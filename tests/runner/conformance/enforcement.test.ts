import { describe, expect, test } from "bun:test";
import { createTrustedHostEnforcement } from "../../../src/runner/adapters/enforcement/trusted-host.ts";

describe("trusted host repository enforcement", () => {
  test("reports advisory truth and never accepts an enforced request", async () => {
    const enforcement = createTrustedHostEnforcement({ id: () => "enforcement_1" });
    expect(enforcement.assurance).toBe("ADVISORY");
    expect(
      await enforcement.activate({ worktree: { id: "worktree_1" }, assurance: "ADVISORY" }),
    ).toEqual({ ok: true, value: { sessionId: "enforcement_1" } });
    expect(
      await enforcement.activate({ worktree: { id: "worktree_1" }, assurance: "ENFORCED" }),
    ).toMatchObject({ ok: false, error: { code: "ASSURANCE_UNAVAILABLE" } });
    expect(await enforcement.inspect("enforcement_1")).toEqual({
      ok: true,
      value: { state: "ACTIVE", assurance: "ADVISORY" },
    });
    expect(await enforcement.revoke("enforcement_1")).toEqual({ ok: true, value: undefined });
    expect(await enforcement.inspect("enforcement_1")).toEqual({
      ok: true,
      value: { state: "REVOKED", assurance: "ADVISORY" },
    });
  });
});
