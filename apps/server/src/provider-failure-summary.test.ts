import {
  MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS,
  PUBLIC_PROVIDER_FAILURE_MESSAGES,
  PUBLIC_PROVIDER_FAILURE_REMEDIATIONS,
  normalizeEngineModelValidationError,
  normalizeProviderFailureCategory,
  publicProviderFailure,
  publicProviderFailureSummary,
} from "@ponderosa/core";
import { describe, expect, it } from "vitest";

const summaries = new Set<string>(Object.values(PUBLIC_PROVIDER_FAILURE_MESSAGES));
const remediations = new Set<string>(Object.values(PUBLIC_PROVIDER_FAILURE_REMEDIATIONS));

describe("publicProviderFailureSummary", () => {
  it("projects every hostile and benign provider string onto the finite public policy", () => {
    const marker = "private-marker-hunter2";
    const corpus = [
      String.raw`pa\u0073sword=${marker}`,
      `pass\u2063word=${marker}`,
      `SECRET_KEY=${marker}`,
      `Basic ${Buffer.from(`user:${marker}`).toString("base64")}`,
      Buffer.from(`password=${marker}`).toString("base64"),
      `/root/.aws/credentials/${marker}`,
      String.raw`C:\Users\Patrick\.aws\credentials`,
      JSON.stringify({ session_id: marker, access_token: marker }),
      "deadline exceeded / operation exceeded retry budget",
      "Ошибка подключения к провайдеру",
      "provider config unavailable",
      "malformed %%% base64 ===",
    ];

    for (const detail of corpus) {
      const failure = publicProviderFailure({ detail });
      expect(summaries.has(failure.summary), detail).toBe(true);
      expect(remediations.has(failure.remediation), detail).toBe(true);
      expect(failure.summary.length).toBeLessThanOrEqual(MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS);
      expect(`${failure.summary} ${failure.remediation}`).not.toContain(marker);
      expect(`${failure.summary} ${failure.remediation}`).not.toContain(detail);
    }
  });

  it("uses only high-confidence mappings and makes unknown input generic", () => {
    expect(publicProviderFailureSummary("subscription inactive")).toBe(
      "Provider authentication was rejected.",
    );
    expect(publicProviderFailureSummary("0 weighted tokens left")).toBe(
      "Provider usage limit was reached.",
    );
    expect(publicProviderFailureSummary("maximum context length exceeded")).toBe(
      "Provider context limit was reached.",
    );
    expect(publicProviderFailureSummary("connection reset by peer")).toBe(
      "Provider is temporarily unavailable.",
    );
    expect(publicProviderFailureSummary("provider config unavailable")).toBe(
      "Provider execution failed.",
    );
    expect(publicProviderFailureSummary("Ошибка подключения к провайдеру")).toBe(
      "Provider execution failed.",
    );
  });

  it("lets bounded structured adapter codes win over prose", () => {
    expect(publicProviderFailure({ detail: "unknown prose", code: "invalid_request" })).toEqual({
      category: "invalid_request",
      summary: "Provider rejected the request.",
      remediation: "Review the request settings, then retry.",
    });
    expect(publicProviderFailure({ detail: "rate limit reached", category: "authentication" }).category)
      .toBe("authentication");
  });

  it("normalizes runtime enum inputs onto finite code-owned values", () => {
    const marker = "HOSTILE_RUNTIME_ENUM_MARKER_92c1";
    expect(normalizeEngineModelValidationError(marker)).toBe("provider_error");
    expect(normalizeProviderFailureCategory(marker)).toBe("unknown");
    expect(normalizeEngineModelValidationError("authentication")).toBe("authentication");
    expect(normalizeProviderFailureCategory("capacity")).toBe("capacity");
  });

  it("terminates with a bounded generic projection for oversized input", () => {
    const marker = "oversized-private-marker";
    const summary = publicProviderFailureSummary(`${marker}${"x".repeat(128 * 1024)}`);
    expect(summary).toBe("Provider execution failed.");
    expect(summary).not.toContain(marker);
  });
});
