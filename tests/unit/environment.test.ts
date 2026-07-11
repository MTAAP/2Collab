import { describe, expect, test } from "bun:test";
import { readServerEnvironment } from "../../src/shared/environment.ts";

describe("readServerEnvironment", () => {
  test("uses loopback-safe development defaults", () => {
    expect(readServerEnvironment({})).toEqual({
      dataDir: "./data",
      hostname: "127.0.0.1",
      mode: "development",
      port: 3210,
      runnerCompositionModule: undefined,
      sessionSecret: undefined,
    });
  });

  test("accepts an explicit valid port", () => {
    expect(readServerEnvironment({ PORT: "4321" }).port).toBe(4321);
  });

  test("rejects a port outside the TCP range", () => {
    expect(() => readServerEnvironment({ PORT: "70000" })).toThrow("PORT");
  });

  test("rejects a non-numeric port", () => {
    expect(() => readServerEnvironment({ PORT: "not-a-port" })).toThrow("PORT");
  });

  test("requires a non-placeholder session secret in production", () => {
    expect(() =>
      readServerEnvironment({
        NODE_ENV: "production",
        SESSION_SECRET: "replace-with-a-random-production-secret",
      }),
    ).toThrow("SESSION_SECRET");
  });

  test("rejects a low-entropy production session secret", () => {
    expect(() =>
      readServerEnvironment({
        NODE_ENV: "production",
        SESSION_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow("SESSION_SECRET");
  });

  test("accepts a strong production session secret", () => {
    const environment = readServerEnvironment({
      HOST: "0.0.0.0",
      NODE_ENV: "production",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    });

    expect(environment.hostname).toBe("0.0.0.0");
    expect(environment.mode).toBe("production");
    expect(environment.sessionSecret).toHaveLength(32);
  });
});
