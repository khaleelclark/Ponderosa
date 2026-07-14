import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatTokens, formatUsd, TokenUsageDetails } from "../src/components/TokenUsageButton";

describe("token usage UI", () => {
  it("renders provider breakdown and makes incomplete historical coverage explicit", () => {
    const html = renderToStaticMarkup(<TokenUsageDetails data={{
      scope: "project", scopeId: "project-1",
      inputTokens: 12_000, cachedInputTokens: 4_000, cacheWriteInputTokens: 1_000, outputTokens: 3_000, reasoningOutputTokens: 800, totalTokens: 15_000,
      finalizedRuns: 4, reportedRuns: 3, unreportedRuns: 1, coverage: 0.75,
      projectedApiCost: { currency: "USD", usd: 0.25, basis: "api_list_price_proxy", catalogVersion: "2026-07-13", pricedRuns: 3, unpricedRuns: 1, coverage: 0.75, breakdown: [{ engine: "codex", requestedModel: "gpt-5.6-luna", pricingModel: "gpt-5.6-luna", proxy: false, runs: 3, usd: 0.25 }] },
    }} />);
    expect(html).toContain("provider-measured tokens processed");
    expect(html).toContain("Cached input");
    expect(html).toContain("Cache writes");
    expect(html).toContain("Usage reported for 3 of 4 finalized runs");
    expect(html).toContain("1 older or unsupported runs are excluded");
    expect(html).toContain("projected API-equivalent list price");
    expect(html).toContain("gpt-5.6-luna");
    expect(formatTokens(0)).toBe("0");
    expect(formatUsd(0.25)).toContain("0.25");
  });
});
