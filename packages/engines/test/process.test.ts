import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { streamProcess, type SpawnFn } from "../src/process.js";

const cwd = import.meta.dirname;
const fakeCodex = join(cwd, "fake-codex.mjs");

function collect(
  beforeSpawn: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal = new AbortController().signal,
  spawnFn: SpawnFn = spawn,
) {
  return Array.fromAsync(
    streamProcess({
      bin: process.execPath,
      args: [fakeCodex, "seed"],
      cwd,
      signal,
      spawnFn,
      beforeSpawn,
      killGraceMs: 50,
      label: "test runtime",
      map: () => [],
    }),
  );
}

describe("streamProcess launch authorization", () => {
  it("claims authorization before spawning the runtime", async () => {
    const order: string[] = [];
    const spawnFn = ((bin: string, args: readonly string[], opts: object) => {
      order.push("spawn");
      return spawn(bin, args, opts);
    }) as SpawnFn;

    const events = await collect(async () => {
      order.push("claim");
    }, undefined, spawnFn);

    expect(events).toEqual([]);
    expect(order).toEqual(["claim", "spawn"]);
  });

  it("does not spawn when registration claim is rejected", async () => {
    const spawnFn = vi.fn() as unknown as SpawnFn;

    const rejection = Object.assign(new Error("proof rejected"), {
      code: "registration_consumed",
    });

    await expect(
      collect(async () => {
        throw rejection;
      }, undefined, spawnFn),
    ).rejects.toBe(rejection);

    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("does not spawn when cancellation races a successful claim", async () => {
    const controller = new AbortController();
    const spawnFn = vi.fn() as unknown as SpawnFn;

    const events = await collect(async () => {
      controller.abort();
    }, controller.signal, spawnFn);

    expect(spawnFn).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "error", message: "run aborted before start" }]);
  });
});
