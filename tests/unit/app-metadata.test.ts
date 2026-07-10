import { describe, expect, test } from "bun:test";
import { APP_METADATA } from "../../src/shared/app-metadata.ts";

describe("APP_METADATA", () => {
  test("publishes stable application and API identity", () => {
    expect(APP_METADATA).toEqual({
      name: "2Collab",
      packageName: "2collab",
      version: "0.1.0",
      apiVersion: "v1",
    });
  });

  test("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(APP_METADATA)).toBe(true);
  });
});
