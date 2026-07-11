import { expect, test } from "bun:test";
import { fingerprintGateManifest } from "../../../src/server/modules/gates/fingerprints.ts";
import { parseTrustedGateManifest } from "../../../src/server/modules/gates/manifest.ts";

const SOURCE = `version = 1

[[gates]]
key = "unit"
kind = "LOCAL_COMMAND"
executable = "bun"
arguments = ["test", "tests/unit"]
working_directory = "."
timeout_ms = 60000
max_output_bytes = 65536

[[gates]]
key = "checks"
kind = "GITHUB_CHECK"
check_name = "verify"
acceptable_conclusions = ["SUCCESS"]

[sets]
pr_ready = ["unit", "checks"]
`;

test("fingerprints the closed manifest deterministically without exposing local recipes", () => {
  const first = parseTrustedGateManifest({
    source: SOURCE,
    manifestRevision: "a".repeat(40),
    trustedBaseRevision: "a".repeat(40),
  });
  const second = parseTrustedGateManifest({
    source: SOURCE.replace("version = 1", "version=1"),
    manifestRevision: "a".repeat(40),
    trustedBaseRevision: "a".repeat(40),
  });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(fingerprintGateManifest(first.value.manifest)).toBe(
    fingerprintGateManifest(second.value.manifest),
  );
  expect(first.value.summary).toMatchObject({
    gateKeys: ["unit", "checks"],
    sets: [{ name: "pr_ready", gateKeys: ["unit", "checks"] }],
  });
  expect(JSON.stringify(first.value.summary)).not.toContain("tests/unit");
  expect(JSON.stringify(first.value.summary)).not.toContain("executable");
});

test("rejects a manifest read from a mutating worktree", () => {
  expect(
    parseTrustedGateManifest({
      source: SOURCE,
      manifestRevision: "b".repeat(40),
      trustedBaseRevision: "a".repeat(40),
    }),
  ).toMatchObject({ ok: false, error: { code: "GATE_MANIFEST_UNTRUSTED" } });
});

test("rejects shell recipes, traversal, duplicate gates, and unknown set members", () => {
  for (const source of [
    SOURCE.replace('executable = "bun"', 'executable = "sh"'),
    SOURCE.replace('working_directory = "."', 'working_directory = "../outside"'),
    SOURCE.replace('key = "checks"', 'key = "unit"'),
    SOURCE.replace('pr_ready = ["unit", "checks"]', 'pr_ready = ["missing"]'),
  ]) {
    expect(
      parseTrustedGateManifest({
        source,
        manifestRevision: "a".repeat(40),
        trustedBaseRevision: "a".repeat(40),
      }),
    ).toMatchObject({ ok: false, error: { code: "GATE_MANIFEST_INVALID" } });
  }
});
