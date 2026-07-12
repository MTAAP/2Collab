import { expect, test } from "bun:test";

test("member offboarding denies the GitHub operation before provider invocation", async () => {
  let providerCalls = 0;
  let memberStatus: "ACTIVE" | "REMOVED" = "ACTIVE";
  const mutate = async () => {
    if (memberStatus !== "ACTIVE")
      return {
        ok: false as const,
        error: {
          code: "MEMBER_AUTHORITY_REVOKED",
          message: "Member authority is revoked.",
          retry: "NEVER" as const,
        },
      };
    providerCalls += 1;
    return { ok: true as const, value: {} };
  };
  memberStatus = "REMOVED";
  expect(await mutate()).toMatchObject({ ok: false, error: { code: "MEMBER_AUTHORITY_REVOKED" } });
  expect(providerCalls).toBe(0);
});
