import type { RuntimeSession } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import {
  invokeProviderSteer,
  readProviderContextUsage,
  readProviderSessionIdentifier,
} from "./provider-session-success.js";

function session(overrides: Record<string, unknown> = {}): RuntimeSession {
  return {
    engineAgentId: "session-valid",
    events: { async *[Symbol.asyncIterator]() { /* empty */ } },
    isAlive: () => true,
    close: async () => undefined,
    startTurn: async () => ({ turnId: "turn" }),
    steer: async () => ({ status: "accepted", turnId: "steer-valid" }),
    interrupt: async () => undefined,
    contextUsage: () => ({
      usedTokens: 10,
      windowTokens: 100,
      providerSessionGeneration: "generation-valid",
    }),
    ...overrides,
  } as RuntimeSession;
}

describe("provider session success boundary", () => {
  it("preserves valid session identifiers, steering, and context usage", async () => {
    const value = session();
    expect(readProviderSessionIdentifier(value)).toBe("session-valid");
    expect(readProviderContextUsage(value)).toEqual({
      usedTokens: 10,
      windowTokens: 100,
      providerSessionGeneration: "generation-valid",
    });
    await expect(invokeProviderSteer(value, { prompt: "next", kind: "user_message" }))
      .resolves.toEqual({ status: "accepted", turnId: "steer-valid" });
  });

  it.each(["getter", "descriptor", "prototype", "revoked"])(
    "contains hostile session traps: %s",
    async (kind) => {
      const marker = `SESSION_SUCCESS_TRAP_MARKER_${kind}`;
      let value: RuntimeSession = session();
      if (kind === "getter") {
        for (const property of ["engineAgentId", "contextUsage", "steer"]) {
          Object.defineProperty(value, property, {
            configurable: true,
            get: () => { throw new Error(`${marker}:${property}`); },
          });
        }
      }
      else if (kind === "descriptor") value = new Proxy(value, {
        getOwnPropertyDescriptor: () => { throw new Error(marker); },
      });
      else if (kind === "prototype") value = new Proxy(Object.create(value) as RuntimeSession, {
        getPrototypeOf: () => { throw new Error(marker); },
      });
      else {
        const revocable = Proxy.revocable(value, {});
        revocable.revoke();
        value = revocable.proxy;
      }
      for (const attempt of [
        () => readProviderSessionIdentifier(value),
        () => readProviderContextUsage(value),
      ]) {
        expect(attempt).toThrow("Provider returned invalid structured data.");
        try { attempt(); } catch (error) { expect(String(error)).not.toContain(marker); }
      }
      await expect(invokeProviderSteer(value, { prompt: "next", kind: "user_message" }))
        .rejects.toThrow("Provider returned invalid structured data.");
    },
  );

  it("contains hostile returned context and steering objects", async () => {
    const marker = "SESSION_RETURN_TOJSON_MARKER_51af access_token=secret";
    const value = session({
      contextUsage: () => ({ usedTokens: 1, toJSON: () => ({ marker }) }),
      steer: async () => ({
        status: "accepted", turnId: "turn", toJSON: () => ({ marker }),
      }),
    });
    expect(() => readProviderContextUsage(value)).toThrow(
      "Provider returned invalid structured data.",
    );
    await expect(invokeProviderSteer(value, { prompt: "next", kind: "user_message" }))
      .rejects.toThrow("Provider returned invalid structured data.");
  });

  it("contains hostile exceptions thrown by session success methods", async () => {
    const marker = "SESSION_METHOD_EXCEPTION_MARKER_222c";
    const hostile = new Proxy(Object.create(null) as object, {
      get: () => { throw new Error(marker); },
      getOwnPropertyDescriptor: () => { throw new Error(marker); },
      ownKeys: () => { throw new Error(marker); },
    });
    const value = session({
      contextUsage: () => { throw hostile; },
      steer: async () => { throw hostile; },
    });
    expect(() => readProviderContextUsage(value)).toThrow(
      "Provider returned invalid structured data.",
    );
    await expect(invokeProviderSteer(value, { prompt: "next", kind: "user_message" }))
      .rejects.toThrow("Provider steering failed.");
  });
});
