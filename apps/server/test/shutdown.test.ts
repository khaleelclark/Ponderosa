import { describe, expect, it, vi } from "vitest";
import { installProcessShutdownHandlers, type ProcessSignalHost } from "../src/shutdown.js";

describe("OS shutdown handlers", () => {
  it("coalesces repeated SIGTERM and SIGINT into one awaited Fastify close", async () => {
    const listeners = new Map<string, (signal: "SIGINT" | "SIGTERM") => void>();
    const host: ProcessSignalHost = {
      on: (event, listener) => { listeners.set(event, listener); },
      off: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn(() => barrier);
    const dispose = installProcessShutdownHandlers({
      close,
      log: { info: vi.fn(), error: vi.fn() },
    } as never, host);

    listeners.get("SIGTERM")!("SIGTERM");
    listeners.get("SIGINT")!("SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
    release();
    await barrier;
    dispose();
    expect(listeners.size).toBe(0);
  });

  it("retries retained provider handles without rerunning Fastify close", async () => {
    const listeners = new Map<string, (signal: "SIGINT" | "SIGTERM") => void>();
    const host: ProcessSignalHost = {
      on: (event, listener) => { listeners.set(event, listener); },
      off: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    };
    const close = vi.fn(async () => { throw new AggregateError([], "Provider runtime shutdown did not complete"); });
    const retryProviderRuntimeShutdown = vi.fn()
      .mockRejectedValueOnce(new Error("provider group still alive"))
      .mockResolvedValueOnce(undefined);
    installProcessShutdownHandlers({
      close,
      retryProviderRuntimeShutdown,
      log: { info: vi.fn(), error: vi.fn() },
    } as never, host);

    listeners.get("SIGTERM")!("SIGTERM");
    await vi.waitFor(() => expect(host.exitCode).toBe(1));
    listeners.get("SIGTERM")!("SIGTERM");
    await vi.waitFor(() => expect(host.exitCode).toBe(0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(retryProviderRuntimeShutdown).toHaveBeenCalledTimes(2);
  });
});
