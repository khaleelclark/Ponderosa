import { describe, expect, it } from "vitest";
import { claudeApiPriceProfile, codexApiPriceProfile } from "../src/api-pricing.js";

describe("API-equivalent price catalog", () => {
  it("prices exact known models and labels aliases as proxies", () => {
    const luna = codexApiPriceProfile("gpt-5.6-luna");
    expect(luna).toMatchObject({
      pricingModel: "gpt-5.6-luna", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 6,
    });
    expect(luna?.proxy).toBeUndefined();
    expect(codexApiPriceProfile("gpt-5.3-codex-spark")).toMatchObject({
      pricingModel: "gpt-5.3-codex", proxy: true,
    });
    expect(claudeApiPriceProfile("sonnet")).toMatchObject({
      pricingModel: "claude-sonnet-4.6", proxy: true,
    });
  });

  it("fails closed for unknown models instead of fuzzy matching or pricing at zero", () => {
    expect(codexApiPriceProfile("future-model")).toBeUndefined();
    expect(claudeApiPriceProfile("future-model")).toBeUndefined();
  });
});
