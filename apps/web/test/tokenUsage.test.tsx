import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens, providerUsageSummaryLabel, TokenUsageDetails } from "../src/components/TokenUsageButton";

describe("token usage UI", () => {
  it("keeps experiment-grade token, Run, request, duration, and scope detail without monetary estimates", () => {
    const html = renderToStaticMarkup(<TokenUsageDetails data={{
      scope: "project", scopeId: "project-1",
      inputTokens: 12_000, cachedInputTokens: 4_000, cacheWriteInputTokens: 1_000, outputTokens: 3_000, reasoningOutputTokens: 800, totalTokens: 15_000,
      finalizedRuns: 4, reportedRuns: 3, unreportedRuns: 1, providerRequests: 9, durationMs: 83_000, coverage: 0.75,
      metricAvailability: { inputTokens: "available", cachedInputTokens: "available", cacheWriteInputTokens: "available", outputTokens: "available", reasoningOutputTokens: "available", totalTokens: "available" },
      breakdown: [{ projectId: "project-1", agentId: "agent-1", agentTitle: "Builder", engine: "codex", model: "gpt-5.6-luna", runs: 3, usage: { totalTokens: 15_000 } }],
      recentTurns: [],
      wakeCauses: [{ cause: "coordination_outcome", runs: 3, activations: 4 }],
    }} />);
    expect(html).toContain("Cached Input");
    expect(html).toContain("Provider Requests");
    expect(html).toContain("Aggregate Run Time");
    expect(html).toContain("1m 23s");
    expect(html).toContain("Usage by Chat and Agent");
    expect(html).toContain("Why Runs Started");
    expect(html).toContain("does not read subscription quotas");
    expect(html).not.toContain("$");
    expect(html).not.toContain("cost estimate");
    expect(formatTokens(0)).toBe("0");
    expect(formatDuration(3_661_000)).toBe("1h 1m");
  });

  it("summarizes only provider telemetry actually retained", () => {
    const summary = {
      scope: "overall" as const, finalizedRuns: 1, reportedRuns: 1, unreportedRuns: 0, coverage: 1,
      metricAvailability: { inputTokens: "available" as const, cachedInputTokens: "unavailable" as const, cacheWriteInputTokens: "unavailable" as const, outputTokens: "available" as const, reasoningOutputTokens: "unavailable" as const, totalTokens: "available" as const },
      breakdown: [{ projectId: "project", agentId: "agent", agentTitle: "Agent", engine: "codex", runs: 1, usage: { totalTokens: 15 } }], recentTurns: [], wakeCauses: [],
    };
    expect(providerUsageSummaryLabel("codex", summary)).toContain("15 tokens across 1 finalized Run");
    expect(providerUsageSummaryLabel("claude", summary)).toContain("unknown");
  });
});
