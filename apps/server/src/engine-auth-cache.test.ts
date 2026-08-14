import { describe, expect, it, vi } from "vitest";
import { EngineAuthStatusCache } from "./engine-auth-cache.js";

describe("EngineAuthStatusCache provider boundary", () => {
  it("coalesces and caches only projected plain auth results", async () => {
    const cache = new EngineAuthStatusCache(1_000, () => 0);
    const load = vi.fn(async () => ({ authenticated: true, detail: "signed in" }));
    const [first, second] = await Promise.all([
      cache.get("codex", load),
      cache.get("codex", load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ authenticated: true, detail: "signed in" });
    expect(second).toEqual(first);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    await expect(cache.get("codex", load)).resolves.toEqual(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("evicts malformed concurrent results and permits a clean retry", async () => {
    const marker = "AUTH_CACHE_TOJSON_MARKER_622d access_token=private-auth-cache";
    let calls = 0;
    const cache = new EngineAuthStatusCache();
    const load = async () => {
      calls += 1;
      return calls === 1
        ? {
            authenticated: true,
            toJSON: () => ({ authenticated: true, detail: marker, access_token: marker }),
          }
        : { authenticated: true, detail: "recovered" };
    };
    const initial = await Promise.allSettled([
      cache.get("codex", load),
      cache.get("codex", load),
    ]);
    expect(initial.every((result) => result.status === "rejected")).toBe(true);
    for (const result of initial) {
      if (result.status === "rejected") expect(String(result.reason)).not.toContain(marker);
    }
    await expect(cache.get("codex", load)).resolves.toEqual({
      authenticated: true,
      detail: "recovered",
    });
    expect(calls).toBe(2);
  });
});
