import { expect, test } from "bun:test";
import { registerOutlineTools } from "../../src/server/adapters/mcp/outline-tools.ts";

test("publishes only bounded Outline search and read MCP operations", () => {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  };
  registerOutlineTools(server as never, {
    async search() {
      return { ok: true };
    },
    async read() {
      return { ok: true };
    },
  });
  expect(names).toEqual(["collab_outline_search", "collab_outline_read"]);
});
