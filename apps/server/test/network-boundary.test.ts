import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@ponderosa/core/config";
import { createServer, type PonderosaServer } from "../src/app.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("network boundary readiness", () => {
  it("reports the validated active posture without exposing the bearer token", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-network-boundary-"));
    const config = loadConfig({
      HOME: "/tmp",
      PONDEROSA_DATA_DIR: dataDir,
      PONDEROSA_HOST: "0.0.0.0",
      PONDEROSA_AUTH_TOKEN: "readiness-secret",
    } as NodeJS.ProcessEnv);
    const app: PonderosaServer = createServer({
      dataDir,
      engines: [],
      authToken: config.authToken,
      networkSecurity: config.networkSecurity,
      logger: false,
    });
    cleanup.push(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });

    const response = await app.inject({ method: "GET", url: "/api/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      networkSecurity: {
        mode: "authenticated",
        bindHost: "0.0.0.0",
        authenticationRequired: true,
      },
    });
    expect(response.body).not.toContain("readiness-secret");
  });

  it("reports the full-operator-access warning for trusted-tailnet mode", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-network-boundary-"));
    const config = loadConfig({
      HOME: "/tmp",
      PONDEROSA_DATA_DIR: dataDir,
      PONDEROSA_HOST: "100.100.101.102",
      PONDEROSA_TRUSTED_TAILNET: "true",
    } as NodeJS.ProcessEnv);
    const app: PonderosaServer = createServer({
      dataDir,
      engines: [],
      networkSecurity: config.networkSecurity,
      logger: false,
    });
    cleanup.push(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });

    expect((await app.inject({ method: "GET", url: "/api/ready" })).json()).toMatchObject({
      networkSecurity: {
        mode: "trusted_tailnet",
        bindHost: "100.100.101.102",
        authenticationRequired: false,
        warning: expect.stringMatching(/peers have full operator access/i),
      },
    });
  });
});
