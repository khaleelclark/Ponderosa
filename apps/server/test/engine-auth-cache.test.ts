import { describe, expect, it } from "vitest";
import { EngineAuthStatusCache } from "../src/engine-auth-cache.js";

describe("EngineAuthStatusCache", () => {
  it("coalesces concurrent probes and reuses the result until expiry", async () => {
    let now = 1_000;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = new EngineAuthStatusCache(30_000, () => now);
    const load = async () => {
      calls += 1;
      await gate;
      return { authenticated: true, detail: `probe ${calls}` };
    };

    const first = cache.get("codex", load);
    const concurrent = cache.get("codex", load);
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { authenticated: true, detail: "probe 1" },
      { authenticated: true, detail: "probe 1" },
    ]);

    await expect(cache.get("codex", load)).resolves.toEqual({ authenticated: true, detail: "probe 1" });
    expect(calls).toBe(1);

    now += 30_001;
    await cache.get("codex", load);
    expect(calls).toBe(2);
  });

  it("does not cache a failed probe", async () => {
    let calls = 0;
    const cache = new EngineAuthStatusCache();
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return { authenticated: true };
    };

    await expect(cache.get("codex", load)).rejects.toThrow("temporary failure");
    await expect(cache.get("codex", load)).resolves.toEqual({ authenticated: true });
    expect(calls).toBe(2);
  });
});
