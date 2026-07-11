import { expect, test } from "bun:test";
import { registerOutlineTools } from "../../src/server/adapters/mcp/outline-tools.ts";

test("publishes only bounded Outline search and read MCP operations", () => {
  const names: string[] = [];
  const handlers: Array<(input: unknown) => Promise<unknown>> = [];
  const server = {
    registerTool(
      name: string,
      _description: unknown,
      handler: (input: unknown) => Promise<unknown>,
    ) {
      names.push(name);
      handlers.push(handler);
    },
  };
  registerOutlineTools(
    server as never,
    {
      kind: "MEMBER",
      memberId: "member_1" as never,
      sessionId: "session_1" as never,
      sessionProof: "proof-with-at-least-thirty-two-bytes",
    },
    {
      async search() {
        return { ok: true };
      },
      async read() {
        return { ok: true };
      },
    },
  );
  expect(names).toEqual(["collab_outline_search", "collab_outline_read"]);
  expect(handlers).toHaveLength(2);
});

test("propagates the authenticated MCP member into Outline operations", async () => {
  let handler: ((input: unknown) => Promise<unknown>) | undefined;
  const actor = {
    kind: "MEMBER" as const,
    memberId: "member_1" as never,
    sessionId: "session_1" as never,
    sessionProof: "proof-with-at-least-thirty-two-bytes",
  };
  registerOutlineTools(
    {
      registerTool(
        _name: string,
        _description: unknown,
        operation: (input: unknown) => Promise<unknown>,
      ) {
        handler ??= operation;
      },
    } as never,
    actor,
    {
      async search(received) {
        expect(received).toBe(actor);
        return { ok: true };
      },
      async read() {
        return { ok: true };
      },
    },
  );
  expect(handler).toBeDefined();
  await handler?.({
    query: {
      query: "design",
      providerLimit: 1,
      resultLimit: 1,
      maximumTotalSnippetBytes: 1024,
      timeoutMs: 1000,
    },
  });
});
