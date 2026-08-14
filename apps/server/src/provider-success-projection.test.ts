import { describe, expect, it } from "vitest";
import {
  projectProviderCapabilities,
  projectProviderUsage,
} from "./provider-success-projection.js";

const validCapabilities = () => ({
  steering: true,
  persistentSessions: true,
  catalogVersion: "catalog-1",
  commands: [{
    name: "status",
    description: "Show provider status",
    source: "provider-advertised",
    acceptsArguments: false,
    insertText: "/status",
    status: "available",
    invocation: "runtime",
  }],
  mcpServers: [],
  composerCapabilities: [],
});

const validUsage = () => ({
  provider: "codex",
  windows: [{ id: "weekly", label: "Weekly", usedPercent: 20 }],
  source: "provider-rpc",
  fetchedAt: "2026-08-14T00:00:00.000Z",
});

describe("provider success projection", () => {
  it("copies valid capability and usage results into closed plain DTOs", () => {
    const capabilities = projectProviderCapabilities(validCapabilities());
    const usage = projectProviderUsage(validUsage(), "codex");
    expect(capabilities).toEqual(validCapabilities());
    expect(usage).toEqual(validUsage());
    expect(Object.getPrototypeOf(capabilities)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(usage)).toBe(Object.prototype);
    expect(JSON.stringify({ capabilities, usage })).toContain("catalog-1");
  });

  it.each([
    "circular",
    "toJSON",
    "getter",
    "ownKeys",
    "revoked",
    "huge",
    "control",
    "secret-field",
  ])("fails closed for hostile capability success data: %s", (kind) => {
    const marker = `CAPABILITY_SUCCESS_HOSTILE_MARKER_${kind}`;
    let value: unknown = validCapabilities();
    if (kind === "circular") {
      (value as Record<string, unknown>).self = value;
    } else if (kind === "toJSON") {
      (value as Record<string, unknown>).toJSON = () => ({ marker });
    } else if (kind === "getter") {
      Object.defineProperty(value, "commands", {
        get: () => { throw new Error(marker); },
        enumerable: true,
      });
    } else if (kind === "ownKeys") {
      value = new Proxy(value as object, {
        ownKeys: () => { throw new Error(marker); },
      });
    } else if (kind === "revoked") {
      const revocable = Proxy.revocable(value as object, {});
      revocable.revoke();
      value = revocable.proxy;
    } else if (kind === "huge") {
      (value as Record<string, unknown>).catalogVersion = marker.repeat(1_000);
    } else if (kind === "control") {
      (value as Record<string, unknown>).catalogVersion = `${marker}\u0000hidden`;
    } else if (kind === "secret-field") {
      (value as Record<string, unknown>).access_token = marker;
    }
    expect(() => projectProviderCapabilities(value)).toThrow(
      "Provider returned invalid structured data.",
    );
    try {
      projectProviderCapabilities(value);
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it.each([
    "circular",
    "toJSON",
    "getter",
    "ownKeys",
    "revoked",
    "huge",
    "control",
    "secret-field",
  ])("fails closed for hostile usage success data: %s", (kind) => {
    const marker = `USAGE_SUCCESS_HOSTILE_MARKER_${kind}`;
    let value: unknown = validUsage();
    if (kind === "circular") {
      (value as Record<string, unknown>).self = value;
    } else if (kind === "toJSON") {
      (value as Record<string, unknown>).toJSON = () => ({ marker });
    } else if (kind === "getter") {
      Object.defineProperty(value, "windows", {
        get: () => { throw new Error(marker); },
        enumerable: true,
      });
    } else if (kind === "ownKeys") {
      value = new Proxy(value as object, {
        ownKeys: () => { throw new Error(marker); },
      });
    } else if (kind === "revoked") {
      const revocable = Proxy.revocable(value as object, {});
      revocable.revoke();
      value = revocable.proxy;
    } else if (kind === "huge") {
      (value as Record<string, unknown>).accountLabel = marker.repeat(1_000);
    } else if (kind === "control") {
      (value as Record<string, unknown>).accountLabel = `${marker}\u0000hidden`;
    } else if (kind === "secret-field") {
      (value as Record<string, unknown>).refresh_token = marker;
    }
    expect(() => projectProviderUsage(value, "codex")).toThrow(
      "Provider returned invalid structured data.",
    );
    try {
      projectProviderUsage(value, "codex");
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it.each([
    ["commands", () => ({
      ...validCapabilities(),
      commands: Array.from({ length: 1_000 }, (_, index) => ({
        name: `command-${index}`,
        description: "d".repeat(8_192),
        source: "provider-advertised",
        acceptsArguments: false,
        insertText: `/command-${index}`,
        status: "available",
        invocation: "runtime",
      })),
    })],
    ["models", () => ({
      ...validCapabilities(),
      modelCatalog: {
        models: Array.from({ length: 500 }, (_, index) => ({
          id: `model-${index}`,
          label: `Model ${index}`,
          description: "m".repeat(8_192),
          kind: "exact",
          source: "provider-probe",
        })),
        cliVersion: "1.0.0",
        configurationKey: "config",
      },
    })],
    ["service-tiers-500x64", () => {
      const serviceTiers = Array.from({ length: 64 }, (_, index) => ({
        id: `tier-${index}`,
        label: `Tier ${index}`,
        description: "t".repeat(8_192),
      }));
      return {
        ...validCapabilities(),
        modelCatalog: {
          models: Array.from({ length: 500 }, (_, index) => ({
            id: `model-${index}`,
            label: `Model ${index}`,
            kind: "exact",
            source: "provider-probe",
            serviceTiers,
          })),
          cliVersion: "1.0.0",
          configurationKey: "config",
        },
      };
    }],
    ["modes", () => ({
      ...validCapabilities(),
      modelCatalog: {
        models: Array.from({ length: 500 }, (_, index) => ({
          id: `model-${index}`,
          label: `Model ${index}`,
          kind: "exact",
          source: "provider-probe",
          efforts: Array.from({ length: 64 }, (_entry, effortIndex) => ({
            id: `effort-${effortIndex}`,
            label: `Effort ${effortIndex}`,
          })),
          supportedEffortLevels: Array.from({ length: 64 }, (_entry, effortIndex) =>
            `effort-${effortIndex}`),
        })),
        cliVersion: "1.0.0",
        configurationKey: "config",
      },
    })],
    ["nested-mixed", () => ({
      ...validCapabilities(),
      commands: Array.from({ length: 100 }, (_, index) => ({
        name: `command-${index}`,
        description: "c".repeat(4_096),
        source: "provider-advertised",
        acceptsArguments: false,
        insertText: `/command-${index}`,
        status: "available",
        invocation: "runtime",
      })),
      composerCapabilities: Array.from({ length: 100 }, (_, index) => ({
        id: `composer-${index}`,
        kind: "plugin",
        label: `Composer ${index}`,
        description: "p".repeat(4_096),
        status: "available",
      })),
    })],
  ])("enforces one cumulative capability budget across %s", (_kind, makeValue) => {
    expect(() => projectProviderCapabilities(makeValue())).toThrow(
      "Provider returned invalid structured data.",
    );
  });

  it("enforces the cumulative UTF-8 budget for schema-valid usage windows", () => {
    const value = {
      ...validUsage(),
      windows: Array.from({ length: 100 }, (_, index) => ({
        id: `窗口-${index}-${"界".repeat(500)}`,
        label: `配额-${index}-${"量".repeat(1_000)}`,
        usedPercent: 20,
        resetsAt: `重置-${index}-${"时".repeat(500)}`,
      })),
    };
    expect(() => projectProviderUsage(value, "codex")).toThrow(
      "Provider returned invalid structured data.",
    );
  });
});
