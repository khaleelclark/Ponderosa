import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { costSummaryLabel, formatTokens, formatUsd, providerUsageSummaryLabel, TokenUsageDetails } from "../src/components/TokenUsageButton";

describe("token usage UI", () => {
  it("leads with provider usage, separates cached and new input, and makes coverage explicit", () => {
    const html = renderToStaticMarkup(<TokenUsageDetails data={{
      scope: "project", scopeId: "project-1",
      inputTokens: 12_000, cachedInputTokens: 4_000, cacheWriteInputTokens: 1_000, outputTokens: 3_000, reasoningOutputTokens: 800, totalTokens: 15_000,
      finalizedRuns: 4, reportedRuns: 3, unreportedRuns: 1, coverage: 0.75,
      breakdown: [{ projectId: "project-1", agentId: "agent-1", agentTitle: "Builder", engine: "codex", model: "gpt-5.6-luna", runs: 3, unpricedRuns: 0, usage: { totalTokens: 15_000 } }],
      wakeCauses: [{ cause: "coordination_outcome", runs: 3, activations: 4 }, { cause: "trigger_occurrence", runs: 1, activations: 1 }],
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
    expect(html).toContain("Usage by provider");
    expect(html).toContain("Ponderosa does not read subscription quotas");
    expect(html).toContain("Cost by token type");
    expect(html).toContain("New input");
    expect(html).toContain("Cached input");
    expect(html).toContain("Cache writes");
    expect(html).toContain("Provider usage was reported for 3 of 4 finalized runs");
    expect(html).toContain("1 older or unsupported runs have no usage data");
    expect(html).toContain("1 run is excluded because model pricing, usage, or request-level detail");
    expect(html).toContain("projected API-equivalent list price");
    expect(html).toContain("Partial estimate");
    expect(html).toContain("Long-context tiers are applied per provider request");
    expect(html).toContain("gpt-5.6-luna");
    expect(html).toContain("Why Runs started");
    expect(html).toContain("coordination outcome · 3 Runs · 4 wake-ups");
    expect(formatTokens(0)).toBe("0");
    expect(formatUsd(0.25)).toContain("0.25");
  });

  it("shows cost unavailable instead of a zero-dollar estimate when no runs can be priced", () => {
    const data = {
      scope: "agent", scopeId: "agent-1",
      inputTokens: 400_000, cachedInputTokens: 300_000, cacheWriteInputTokens: 0, outputTokens: 5_000, reasoningOutputTokens: 1_000, totalTokens: 405_000,
      finalizedRuns: 1, reportedRuns: 1, unreportedRuns: 0, coverage: 1,
      wakeCauses: [],
      projectedApiCost: {
        currency: "USD", usd: 0, basis: "api_list_price_proxy", catalogVersion: "2026-07-13", pricedRuns: 0, unpricedRuns: 1, coverage: 0,
        components: { uncachedInput: { tokens: 0, usd: 0 }, cachedInput: { tokens: 0, usd: 0 }, cacheWriteInput: { tokens: 0, usd: 0 }, output: { tokens: 0, usd: 0 } },
        breakdown: [],
      },
    } as const;
    const html = renderToStaticMarkup(<TokenUsageDetails data={data} />);

    expect(html).toContain("Cost unavailable");
    expect(html).toContain("request-level usage detail");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("Cost by token type");
    expect(costSummaryLabel(data)).toBe("Cost unavailable");
  });

  it("marks mixed-coverage button totals as partial", () => {
    expect(costSummaryLabel({
      scope: "overall",
      inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110,
      finalizedRuns: 2, reportedRuns: 2, unreportedRuns: 0, coverage: 1,
      wakeCauses: [],
      projectedApiCost: {
        currency: "USD", usd: 1.25, basis: "api_list_price_proxy", catalogVersion: "test", pricedRuns: 1, unpricedRuns: 1, coverage: 0.5,
        components: { uncachedInput: { tokens: 100, usd: 0.25 }, cachedInput: { tokens: 0, usd: 0 }, cacheWriteInput: { tokens: 0, usd: 0 }, output: { tokens: 10, usd: 1 } },
        breakdown: [],
      },
    })).toContain("Partial · $1.25");
  });

  it("shows provider telemetry only when a provider actually reported it", () => {
    const data = {
      scope: "overall",
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 15,
      finalizedRuns: 1,
      reportedRuns: 1,
      unreportedRuns: 0,
      coverage: 1,
      metricAvailability: { inputTokens: "available", cachedInputTokens: "available", cacheWriteInputTokens: "available", outputTokens: "available", reasoningOutputTokens: "available", totalTokens: "available" },
      recentTurns: [],
      wakeCauses: [],
      breakdown: [{ projectId: "project", agentId: "agent", agentTitle: "Agent", engine: "codex", runs: 1, pricingAvailableRuns: 0, unpricedRuns: 1, usage: { totalTokens: 15 } }],
    } as const;
    expect(providerUsageSummaryLabel("codex", data)).toContain("15 tokens across 1 finalized Run");
    expect(providerUsageSummaryLabel("claude", data)).toContain("unknown");
    expect(providerUsageSummaryLabel("codex", undefined, true)).toContain("checking");
  });
});
