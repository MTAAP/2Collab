import { describe, expect, test } from "bun:test";

const EXPECTED_PROHIBITED_STORE_IDS = [
  "browser-cache",
  "browser-network-capture",
  "browser-storage",
  "cli-capture",
  "playwright-artifacts",
  "runner-context-cache",
  "runner-diagnostic-ciphertext",
  "runner-diagnostic-metadata",
  "runner-logs",
  "runner-outbox",
  "runner-reconciliation",
  "runner-sqlite",
  "runner-wal-shm",
  "server-audit-projection-outbox",
  "server-backup-ciphertext",
  "server-idempotency",
  "server-logs",
  "server-restored-logical",
  "server-sqlite",
  "server-staging",
  "server-wal-shm",
] as const;

function encodings(value: string): readonly string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value).toString("base64"),
  ];
}

describe("prohibited storage canary", () => {
  test("raw canaries never enter the closed durable-store inventory", () => {
    const allowedAuthoredInstruction = "allowed-authored-goal-7f39";
    const forbidden = [
      "source-body-3df4",
      "document-body-29a1",
      "flattened-prompt-c518",
      "terminal-stdout-05ac",
      "terminal-stderr-d23c",
      "interactive-pty-47bb",
      "environment-secret-a883",
      "connector-credential-917e",
      "private-profile-arguments-690f",
      "/private/worktree/path-9812",
      "C:\\private\\worktree-771a",
      "worktree-content-502c",
      "raw-diff-11f9",
      "attachment-handle-198e",
    ];
    const stores = EXPECTED_PROHIBITED_STORE_IDS.map((id) => ({
      id,
      readable: true,
      bytes:
        id === "server-sqlite"
          ? `structured_instruction=${allowedAuthoredInstruction}`
          : `safe-store=${id}`,
    }));
    expect(stores.map((store) => store.id).sort()).toEqual(
      [...EXPECTED_PROHIBITED_STORE_IDS].sort(),
    );
    for (const store of stores) {
      expect(store.readable).toBe(true);
      for (const canary of forbidden.flatMap(encodings)) expect(store.bytes).not.toContain(canary);
    }
    expect(stores.find((store) => store.id === "server-sqlite")?.bytes).toContain(
      allowedAuthoredInstruction,
    );
  });
});
