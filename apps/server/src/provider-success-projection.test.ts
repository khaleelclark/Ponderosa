import { describe, expect, it } from "vitest";
import {
  projectProviderCapabilities,
  projectProviderAuthStatus,
  projectProviderAvailabilityStatus,
  projectProviderCommandResult,
  projectProviderContextUsage,
  projectProviderEffortOptions,
  projectProviderModelCatalog,
  projectProviderModelOptions,
  projectProviderModelValidation,
  projectProviderSessionIdentifier,
  projectProviderSteerResult,
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

  it("copies valid model, catalog, validation, effort, and command successes", () => {
    const model = { id: "gpt-5", label: "GPT-5", efforts: [{ id: "high", label: "High" }] };
    const catalogModel = { ...model, kind: "alias" as const, source: "provider-probe" as const };
    expect(projectProviderModelOptions([model])).toEqual([model]);
    expect(projectProviderEffortOptions(model.efforts)).toEqual(model.efforts);
    expect(projectProviderModelCatalog({
      models: [catalogModel], cliVersion: "1.2.3", configurationKey: "default",
    })).toEqual({ models: [catalogModel], cliVersion: "1.2.3", configurationKey: "default" });
    expect(projectProviderModelValidation({ valid: true, model: catalogModel }))
      .toEqual({ valid: true, model: catalogModel });
    expect(projectProviderModelValidation({
      valid: false, errorCode: "model_not_found", error: "not found",
    })).toEqual({ valid: false, errorCode: "model_not_found", error: "not found" });
    expect(projectProviderCommandResult({ message: "Runtime is healthy." }))
      .toEqual({ message: "Runtime is healthy." });
  });

  it("copies valid auth, availability, steering, context, and session successes", () => {
    expect(projectProviderAuthStatus({ authenticated: true, detail: "signed in" }))
      .toEqual({ authenticated: true, detail: "signed in" });
    expect(projectProviderAvailabilityStatus({
      available: false, failureCategory: "rate_limit", detail: "quota reached",
    })).toEqual({ available: false, failureCategory: "rate_limit", detail: "quota reached" });
    expect(projectProviderAvailabilityStatus({
      available: false, failureCategory: "adapter_future_category",
    })).toEqual({ available: false, failureCategory: "unknown" });
    expect(projectProviderSteerResult({ status: "accepted", turnId: "turn-1" }))
      .toEqual({ status: "accepted", turnId: "turn-1" });
    expect(projectProviderContextUsage({
      usedTokens: 10, windowTokens: 100, aggregateTokens: 20,
      providerSessionGeneration: "generation-1",
    })).toEqual({
      usedTokens: 10, windowTokens: 100, aggregateTokens: 20,
      providerSessionGeneration: "generation-1",
    });
    expect(projectProviderSessionIdentifier("session-1")).toBe("session-1");
  });

  it.each(["toJSON", "getter", "descriptor", "ownKeys", "proxy", "revoked", "huge", "control", "secret", "malformed"])(
    "fails closed for remaining provider success schemas: %s",
    (kind) => {
      const marker = `ADJACENT_SUCCESS_MARKER_${kind}`;
      const hostile = (base: Record<string, unknown>): unknown => {
        if (kind === "toJSON") base.toJSON = () => ({ marker });
        else if (kind === "getter") Object.defineProperty(base, Object.keys(base)[0]!, {
          enumerable: true, get: () => { throw new Error(marker); },
        });
        else if (kind === "descriptor") return new Proxy(base, {
          getOwnPropertyDescriptor: () => { throw new Error(marker); },
        });
        else if (kind === "ownKeys") return new Proxy(base, {
          ownKeys: () => { throw new Error(marker); },
        });
        else if (kind === "proxy") return new Proxy(base, {
          getPrototypeOf: () => { throw new Error(marker); },
        });
        else if (kind === "revoked") {
          const value = Proxy.revocable(base, {});
          value.revoke();
          return value.proxy;
        } else if (kind === "huge") base[Object.keys(base)[0]!] = marker.repeat(1_000);
        else if (kind === "control") base[Object.keys(base)[0]!] = `${marker}\u0000hidden`;
        else if (kind === "secret") base.access_token = marker;
        else base[Object.keys(base)[0]!] = 1n;
        return base;
      };
      const attempts = [
        () => projectProviderAuthStatus(hostile({ authenticated: true, detail: "ok" })),
        () => projectProviderAvailabilityStatus(hostile({ available: true, detail: "ok" })),
        () => projectProviderSteerResult(hostile({ status: "accepted", turnId: "turn" })),
        () => projectProviderContextUsage(hostile({ usedTokens: 1, providerSessionGeneration: "generation" })),
      ];
      for (const attempt of attempts) {
        expect(attempt).toThrow("Provider returned invalid structured data.");
        try { attempt(); } catch (error) { expect(String(error)).not.toContain(marker); }
      }
    },
  );

  it("rejects malformed enums, numeric bounds, and identifier budgets", () => {
    expect(() => projectProviderSteerResult({ status: "accepted", reason: "impossible" }))
      .toThrow("Provider returned invalid structured data.");
    expect(() => projectProviderSteerResult({ status: "future_status" }))
      .toThrow("Provider returned invalid structured data.");
    expect(() => projectProviderContextUsage({ usedTokens: -1 }))
      .toThrow("Provider returned invalid structured data.");
    expect(() => projectProviderContextUsage({ usedTokens: Number.POSITIVE_INFINITY }))
      .toThrow("Provider returned invalid structured data.");
    expect(() => projectProviderSessionIdentifier("x".repeat(513)))
      .toThrow("Provider returned invalid structured data.");
    expect(() => projectProviderSessionIdentifier("access_token=private-session"))
      .toThrow("Provider returned invalid structured data.");
  });

  it.each([
    "toJSON", "getter", "descriptor", "ownKeys", "circular", "proxy", "revoked",
    "enum", "shape", "huge", "deep", "wide", "symbol", "function", "bigint", "control", "secret",
  ])("fails closed for hostile model successes: %s", (kind) => {
    const marker = `MODEL_SUCCESS_HOSTILE_MARKER_${kind}`;
    let row: unknown = {
      id: "gpt-5", label: "GPT-5", kind: "alias", source: "provider-probe",
    };
    let value: unknown = [row];
    if (kind === "toJSON") (row as Record<string, unknown>).toJSON = () => ({ marker });
    else if (kind === "getter") Object.defineProperty(row, "label", {
      enumerable: true, get: () => { throw new Error(marker); },
    });
    else if (kind === "descriptor") row = new Proxy(row as object, {
      getOwnPropertyDescriptor: () => { throw new Error(marker); },
    }), value = [row];
    else if (kind === "ownKeys") row = new Proxy(row as object, {
      ownKeys: () => { throw new Error(marker); },
    }), value = [row];
    else if (kind === "circular") (row as Record<string, unknown>).self = row;
    else if (kind === "proxy") value = new Proxy(value as object, {
      getPrototypeOf: () => { throw new Error(marker); },
    });
    else if (kind === "revoked") {
      const revocable = Proxy.revocable(row as object, {});
      revocable.revoke();
      value = [revocable.proxy];
    } else if (kind === "enum") (row as Record<string, unknown>).kind = marker;
    else if (kind === "shape") value = { models: [row] };
    else if (kind === "huge") (row as Record<string, unknown>).description = marker.repeat(1_000);
    else if (kind === "deep") (row as Record<string, unknown>).serviceTiers = [{
      id: "tier", label: "Tier", description: "x", nested: { marker },
    }];
    else if (kind === "wide") value = Array.from({ length: 501 }, () => row);
    else if (kind === "symbol") (row as Record<PropertyKey, unknown>)[Symbol(marker)] = marker;
    else if (kind === "function") (row as Record<string, unknown>).description = () => marker;
    else if (kind === "bigint") (row as Record<string, unknown>).description = 1n;
    else if (kind === "control") (row as Record<string, unknown>).label = `${marker}\u0000hidden`;
    else if (kind === "secret") (row as Record<string, unknown>).access_token = marker;
    expect(() => projectProviderModelOptions(value)).toThrow("Provider returned invalid structured data.");
  });

  it("enforces one cumulative model catalog budget and closed validation shapes", () => {
    const hugeCatalog = {
      models: Array.from({ length: 500 }, (_, index) => ({
        id: `model-${index}`,
        label: `Model ${index}`,
        description: "x".repeat(8_192),
        kind: "exact",
        source: "provider-probe",
      })),
      cliVersion: "1.2.3",
      configurationKey: "default",
    };
    expect(() => projectProviderModelCatalog(hugeCatalog)).toThrow(
      "Provider returned invalid structured data.",
    );
    expect(() => projectProviderModelValidation({
      valid: true,
      model: { id: "gpt-5", label: "GPT-5", kind: "alias", source: "provider-probe" },
      access_token: "MODEL_VALIDATION_SECRET_MARKER",
    })).toThrow("Provider returned invalid structured data.");
  });

  it.each(["toJSON", "getter", "ownKeys", "revoked", "huge", "control", "secret"])(
    "fails closed for hostile provider-command successes: %s",
    (kind) => {
      const marker = `COMMAND_SUCCESS_HOSTILE_MARKER_${kind}`;
      let value: unknown = { message: "ok" };
      if (kind === "toJSON") (value as Record<string, unknown>).toJSON = () => ({ marker });
      else if (kind === "getter") Object.defineProperty(value, "message", {
        enumerable: true, get: () => { throw new Error(marker); },
      });
      else if (kind === "ownKeys") value = new Proxy(value as object, {
        ownKeys: () => { throw new Error(marker); },
      });
      else if (kind === "revoked") {
        const revocable = Proxy.revocable(value as object, {});
        revocable.revoke();
        value = revocable.proxy;
      } else if (kind === "huge") (value as Record<string, unknown>).message = marker.repeat(1_000);
      else if (kind === "control") (value as Record<string, unknown>).message = `${marker}\u0000hidden`;
      else if (kind === "secret") (value as Record<string, unknown>).access_token = marker;
      expect(() => projectProviderCommandResult(value)).toThrow(
        "Provider returned invalid structured data.",
      );
    },
  );

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
