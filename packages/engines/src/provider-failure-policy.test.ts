import {
  classifyProviderFailure as classifyCoreProviderFailure,
  MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS,
  publicProviderFailureCategorySummary,
  publicProviderFailureSummary,
} from "@ponderosa/core";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { classifyProviderFailure as classifyEngineProviderFailure } from "./session-recovery.js";

const encoded = (value: string): string => Buffer.from(value, "utf8").toString("base64");
const encodedUrl = (value: string): string => encoded(value)
  .replace(/\+/gu, "-")
  .replace(/\//gu, "_")
  .replace(/=+$/u, "");

describe("canonical public provider-failure policy", () => {
  it("recursively rejects reversible base64 and base64url plaintext credentials", () => {
    const password = encoded("password=hunter2");
    const nestedJson = encoded(JSON.stringify({ message: password }));
    const corpus = [
      password,
      encodedUrl("password=hunter2"),
      nestedJson,
      encoded(JSON.stringify({ message: nestedJson })),
      encoded("Basic dXNlcjpodW50ZXIy"),
      encoded("signing_key=x"),
    ];
    for (const detail of corpus) {
      expect(publicProviderFailureSummary(detail), detail).toBeUndefined();
    }
  });

  it("classifies confusable security labels using their bounded skeleton", () => {
    const restricted = [
      "Вearer short123",
      "Веагег short123",
      "сode=hunter2",
      "cοԁе=hunter2",
      "Вasic dXNlcjpodW50ZXIy",
      "Basic dXNlcjpodW50ZXIy",
    ];
    for (const detail of restricted) {
      expect(publicProviderFailureSummary(detail), detail).toBeUndefined();
    }
  });

  it("rejects credentialed URI userinfo, semantic key families, and short provider tokens", () => {
    const semanticFamilies = [
      "signing_key", "key_signing", "encryption-key", "key-encryption", "ssh_key", "key_ssh",
      "secret_value", "value_secret", "password_value", "value_password", "session_cookie",
      "cookie_session", "passphrase", "access_key_id", "id_access_key", "api+key", "key_api",
    ];
    const separators = ["=", ":"];
    const corpus = [
      "https://user:hunter2@example.com/runtime",
      "ssh://private-token@example.com/repository",
      "sk-abc123",
      "sk-ant-abc123",
      "ghp_abc123",
      "xoxb-123456",
      ...semanticFamilies.flatMap((family) =>
        separators.map((separator) => `runtime_${family}${separator}x`)),
    ];
    for (const detail of corpus) {
      expect(publicProviderFailureSummary(detail), detail).toBeUndefined();
    }
  });

  it("retains deterministic benign and localized detail", () => {
    const safe = [
      "deadline exceeded",
      "operation exceeded retry budget",
      "deadline exceeded / operation exceeded retry budget",
      "not-valid-base64===",
      "paあssword=hunter2",
      "Ошибка подключения к провайдеру",
      "プロバイダーへの接続に失敗しました",
      "فشل الاتصال بمزود الخدمة",
    ];
    for (const detail of safe) {
      expect(publicProviderFailureSummary(detail), detail).toBe(detail);
    }
  });

  it("keeps decoding depth, normalization passes, candidate count, and output bounded", () => {
    let nested = "password=hunter2";
    for (let depth = 0; depth <= 8; depth += 1) {
      nested = encoded(nested);
      expect(publicProviderFailureSummary(nested), `depth ${depth + 1}`).toBeUndefined();
    }

    let escapeLayer = "%73";
    for (let pass = 0; pass < 10; pass += 1) escapeLayer = escapeLayer.replaceAll("%", "%25");
    expect(publicProviderFailureSummary(`pa${escapeLayer}sword=x`)).toBeUndefined();

    const candidateFlood = Array.from({ length: 20 }, (_, index) => encoded(`safe ${index}`)).join(" ");
    expect(publicProviderFailureSummary(candidateFlood)).toBeUndefined();

    const bounded = publicProviderFailureSummary(`provider unavailable ${"x".repeat(1_000)}`);
    expect(bounded?.length).toBe(MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS);
  });

  it("uses one canonical category for engine, server summaries, and browser consumers", () => {
    const corpus = [
      ["subscription expired", "authentication", "Provider authentication was rejected."],
      ["subscription inactive", "authentication", "Provider authentication was rejected."],
      ["0 weighted tokens left", "rate_limit", "Provider usage limit was reached."],
      ["selected model is at capacity", "capacity", "Provider is temporarily at capacity."],
    ] as const;
    for (const [detail, category, summary] of corpus) {
      expect(classifyCoreProviderFailure(detail)).toBe(category);
      expect(classifyEngineProviderFailure(detail)).toBe(category);
      expect(publicProviderFailureCategorySummary(detail)).toBe(summary);
    }
  });
});
