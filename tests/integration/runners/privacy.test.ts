import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner storage privacy", () => {
  test("has no columns for local paths, commands, environment, connector state, or clear secrets", () => {
    const fixture = createRunnerFixture();
    try {
      const columns = fixture.database
        .query<{ name: string }, []>(
          "SELECT name FROM pragma_table_info('runners') UNION ALL SELECT name FROM pragma_table_info('safe_profile_versions') UNION ALL SELECT name FROM pragma_table_info('runner_credentials')",
        )
        .all()
        .map((row) => row.name);
      for (const prohibited of [
        "local_path",
        "command",
        "arguments",
        "environment",
        "clear_secret",
        "connector_state",
        "clear_credential",
      ]) {
        expect(columns).not.toContain(prohibited);
      }
    } finally {
      fixture.close();
    }
  });
});
