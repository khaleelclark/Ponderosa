import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatTokens, TokenUsageDetails } from "../src/components/TokenUsageButton";

describe("token usage UI", () => {
  it("renders provider breakdown and makes incomplete historical coverage explicit", () => {
    const html = renderToStaticMarkup(<TokenUsageDetails data={{
      scope: "project", scopeId: "project-1",
      inputTokens: 12_000, cachedInputTokens: 4_000, outputTokens: 3_000, reasoningOutputTokens: 800, totalTokens: 15_000,
      finalizedRuns: 4, reportedRuns: 3, unreportedRuns: 1, coverage: 0.75,
    }} />);
    expect(html).toContain("provider-reported tokens processed");
    expect(html).toContain("Cached input");
    expect(html).toContain("Usage reported for 3 of 4 finalized runs");
    expect(html).toContain("1 older or unsupported runs are excluded");
    expect(html).toContain("not compute time or cost");
    expect(formatTokens(0)).toBe("0");
  });
});
