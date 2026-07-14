import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatTokens, formatUsd, TokenUsageDetails } from "../src/components/TokenUsageButton";

describe("token usage UI", () => {
  it("leads with cost, separates cached and new input, and makes coverage explicit", () => {
    const html = renderToStaticMarkup(<TokenUsageDetails data={{
      scope: "project", scopeId: "project-1",
      inputTokens: 12_000, cachedInputTokens: 4_000, cacheWriteInputTokens: 1_000, outputTokens: 3_000, reasoningOutputTokens: 800, totalTokens: 15_000,
      finalizedRuns: 4, reportedRuns: 3, unreportedRuns: 1, coverage: 0.75,
      projectedApiCost: {
        currency: "USD", usd: 0.25, basis: "api_list_price_proxy", catalogVersion: "2026-07-13", pricedRuns: 3, unpricedRuns: 1, coverage: 0.75,
        components: { uncachedInput: { tokens: 7_000, usd: 0.01 }, cachedInput: { tokens: 4_000, usd: 0.002 }, cacheWriteInput: { tokens: 1_000, usd: 0.003 }, output: { tokens: 3_000, usd: 0.235 } },
        breakdown: [{
          engine: "codex", requestedModel: "gpt-5.6-luna", pricingModel: "gpt-5.6-luna", proxy: false, runs: 3, usd: 0.25,
          components: { uncachedInput: { tokens: 7_000, usd: 0.01 }, cachedInput: { tokens: 4_000, usd: 0.002 }, cacheWriteInput: { tokens: 1_000, usd: 0.003 }, output: { tokens: 3_000, usd: 0.235 } },
        }],
      },
    }} />);
    expect(html).not.toContain("provider-measured tokens processed");
    expect(html).toContain("Cost by token type");
    expect(html).toContain("New input");
    expect(html).toContain("Cached input");
    expect(html).toContain("Cache writes");
    expect(html).toContain("Provider usage was reported for 3 of 4 finalized runs");
    expect(html).toContain("1 older or unsupported runs have no usage data");
    expect(html).toContain("1 run is excluded from cost");
    expect(html).toContain("projected API-equivalent list price");
    expect(html).toContain("gpt-5.6-luna");
    expect(formatTokens(0)).toBe("0");
    expect(formatUsd(0.25)).toContain("0.25");
  });
});
