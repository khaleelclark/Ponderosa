import type { LauncherShutdownReceiptDto } from "@ponderosa/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import { launcherShutdownReceiptPath } from "./launcher-shutdown-receipt.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function readReceiptEventually(
  pathname: string,
): Promise<LauncherShutdownReceiptDto> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const receipt = JSON.parse(readFileSync(pathname, "utf8")) as LauncherShutdownReceiptDto;
      if (receipt.state !== "pending") return receipt;
    } catch { /* The receipt is published asynchronously after Fastify close. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("launcher shutdown receipt did not become terminal");
}

describe("launcher-requested shutdown receipt", () => {
  it.each([
    {
      label: "background cleanup",
      shutdownFaults: {
        backgroundCleanup: () => { throw new Error("injected background cleanup failed"); },
      },
    },
    {
      label: "provider close",
      shutdownFaults: {
        providerClose: () => { throw new Error("injected provider close failed"); },
      },
    },
    {
      label: "hung background cleanup timeout",
      shutdownFaults: {
        backgroundCleanup: () => new Promise<void>(() => undefined),
        backgroundCleanupTimeoutMs: 10,
      },
    },
  ])("durably records incomplete when $label rejects", async ({ shutdownFaults }) => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-server-shutdown-receipt-"));
    roots.push(root);
    const launcherRoot = path.join(root, "launcher");
    const generation = "22222222-2222-4222-8222-222222222222";
    const controlToken = "control-token-".repeat(4);
    const app = createServer({
      dataDir: path.join(root, "data"),
      launcherDataDir: launcherRoot,
      launcherGeneration: generation,
      launcherSecurity: { controlToken },
      engines: [],
      shutdownFaults,
    });
    await app.ready();
    const requestedAt = "2026-08-14T00:00:00.000Z";
    const response = await app.inject({
      method: "POST",
      url: "/api/launcher/shutdown",
      headers: { authorization: `Bearer ${controlToken}` },
      payload: { generation, requestedAt },
    });
    expect(response.statusCode).toBe(202);

    const receipt = await readReceiptEventually(
      launcherShutdownReceiptPath(launcherRoot, generation),
    );
    expect(receipt).toMatchObject({
      generation,
      pid: process.pid,
      requestedAt,
      state: "incomplete",
      error: "Ponderosa server shutdown did not complete",
    });
    expect(process.exitCode).toBe(1);
  });

  it("promotes an incomplete receipt only after an exact strict-cleanup retry succeeds", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-server-shutdown-retry-"));
    roots.push(root);
    const launcherRoot = path.join(root, "launcher");
    const generation = "33333333-3333-4333-8333-333333333333";
    const controlToken = "control-token-".repeat(4);
    let attempts = 0;
    const app = createServer({
      dataDir: path.join(root, "data"),
      launcherDataDir: launcherRoot,
      launcherGeneration: generation,
      launcherSecurity: { controlToken },
      engines: [],
      shutdownFaults: {
        backgroundCleanup: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("first strict cleanup attempt failed");
        },
      },
    });
    await app.ready();
    const requestedAt = "2026-08-14T01:00:00.000Z";
    expect((await app.inject({
      method: "POST",
      url: "/api/launcher/shutdown",
      headers: { authorization: `Bearer ${controlToken}` },
      payload: { generation, requestedAt },
    })).statusCode).toBe(202);
    const pathname = launcherShutdownReceiptPath(launcherRoot, generation);
    expect(await readReceiptEventually(pathname)).toMatchObject({ state: "incomplete" });

    await app.retryShutdownCleanup();
    app.completeLauncherShutdownRecovery?.();
    expect(JSON.parse(readFileSync(pathname, "utf8"))).toMatchObject({
      generation,
      requestedAt,
      state: "clean",
    });
    expect(attempts).toBe(2);
    process.exitCode = undefined;
  });
});
