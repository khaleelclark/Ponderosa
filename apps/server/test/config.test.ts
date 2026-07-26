import { describe, expect, it } from "vitest";
import { isTailscaleAddress, loadConfig } from "@ponderosa/core/config";

describe("V1 server configuration", () => {
  it("defaults to a loopback-only listener", () => {
    const config = loadConfig({ HOME: "/tmp" } as NodeJS.ProcessEnv);
    expect(config.host).toBe("127.0.0.1");
    expect(config.authToken).toBeUndefined();
    expect(config.networkSecurity).toMatchObject({
      mode: "loopback",
      bindHost: "127.0.0.1",
      authenticationRequired: false,
    });
  });

  it("requires authentication for wildcard, LAN, and public listeners", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "203.0.113.4", "ponderosa.example.test"]) {
      expect(() => loadConfig({ HOME: "/tmp", PONDEROSA_HOST: host } as NodeJS.ProcessEnv), host)
        .toThrow(/requires PONDEROSA_AUTH_TOKEN or PONDEROSA_TRUSTED_TAILNET/);
    }
    const config = loadConfig({
      HOME: "/tmp",
      PONDEROSA_HOST: "0.0.0.0",
      PONDEROSA_AUTH_TOKEN: " operator-secret ",
    } as NodeJS.ProcessEnv);
    expect(config.authToken).toBe("operator-secret");
    expect(config.networkSecurity).toMatchObject({
      mode: "authenticated",
      bindHost: "0.0.0.0",
      authenticationRequired: true,
    });
  });

  it("allows unauthenticated trusted-tailnet mode only on literal Tailscale addresses", () => {
    for (const host of ["100.64.0.0", "100.100.101.102", "100.127.255.255", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ffff::1"]) {
      expect(isTailscaleAddress(host), host).toBe(true);
      expect(loadConfig({
        HOME: "/tmp",
        PONDEROSA_HOST: host,
        PONDEROSA_TRUSTED_TAILNET: "true",
      } as NodeJS.ProcessEnv).networkSecurity).toMatchObject({
        mode: "trusted_tailnet",
        bindHost: host,
        authenticationRequired: false,
      });
    }
    for (const host of ["127.0.0.1", "::1", "0.0.0.0", "::", "100.63.255.255", "100.128.0.0", "192.168.1.20", "fd7a:115c:a1df:ffff::1", "fd7a:115c:a1e0::1%tailscale0", "fd7a:115c:a1e1::1", "node.tailnet.example"]) {
      expect(isTailscaleAddress(host), host).toBe(false);
      expect(() => loadConfig({
        HOME: "/tmp",
        PONDEROSA_HOST: host,
        PONDEROSA_TRUSTED_TAILNET: "true",
      } as NodeJS.ProcessEnv), host).toThrow(/literal Tailscale/);
    }
  });

  it("rejects ambiguous trusted-tailnet flag values", () => {
    expect(() => loadConfig({
      HOME: "/tmp",
      PONDEROSA_TRUSTED_TAILNET: "1",
    } as NodeJS.ProcessEnv)).toThrow(/must be exactly true/);
  });

  it("has one canonical communication mode regardless of retired migration flags", () => {
    const config = loadConfig({
      HOME: "/tmp",
      PONDEROSA_COMMUNICATION_MODE: "off",
      PONDEROSA_COMMUNICATION_READ_MODE: "legacy",
      PONDEROSA_LEGACY_ROUTING: "accept",
    } as NodeJS.ProcessEnv);
    expect(config).not.toHaveProperty("communicationMode");
    expect(config).not.toHaveProperty("communicationReadMode");
    expect(config).not.toHaveProperty("legacyRoutingMode");
  });
});
