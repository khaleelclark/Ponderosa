import type { ApiPriceProfile } from "@ponderosa/core";

const CATALOG_VERSION = "2026-07-13";
const CLAUDE_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";

function openai(
  id: string,
  input: number,
  cached: number,
  output: number,
  options: { proxy?: boolean; pricingModel?: string; longContext?: boolean } = {},
): ApiPriceProfile {
  return {
    id,
    pricingModel: options.pricingModel ?? id,
    catalogVersion: CATALOG_VERSION,
    effectiveAt: CATALOG_VERSION,
    sourceUrl: `https://developers.openai.com/api/docs/models/${options.pricingModel ?? id}`,
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: cached,
    cacheWriteInputUsdPerMillion: input * 1.25,
    outputUsdPerMillion: output,
    ...(options.proxy ? { proxy: true } : {}),
    ...(options.longContext ? { longContext: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    } } : {}),
  };
}

const CODEX_PRICES = new Map<string, ApiPriceProfile>([
  ["gpt-5.6-sol", openai("gpt-5.6-sol", 5, 0.5, 30, { longContext: true })],
  ["gpt-5.6-terra", openai("gpt-5.6-terra", 2.5, 0.25, 15, { longContext: true })],
  ["gpt-5.6-luna", openai("gpt-5.6-luna", 1, 0.1, 6, { longContext: true })],
  ["gpt-5.5", openai("gpt-5.5", 5, 0.5, 30, { longContext: true })],
  ["gpt-5.4", openai("gpt-5.4", 2.5, 0.25, 15, { longContext: true })],
  ["gpt-5.4-mini", openai("gpt-5.4-mini", 0.75, 0.075, 4.5)],
  ["gpt-5.3-codex-spark", openai("gpt-5.3-codex-spark", 1.75, 0.175, 14, {
    proxy: true,
    pricingModel: "gpt-5.3-codex",
  })],
]);

function claude(
  id: string,
  pricingModel: string,
  input: number,
  output: number,
  proxy: boolean,
): ApiPriceProfile {
  return {
    id,
    pricingModel,
    catalogVersion: CATALOG_VERSION,
    effectiveAt: CATALOG_VERSION,
    sourceUrl: CLAUDE_PRICING_URL,
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: input * 0.1,
    cacheWriteInputUsdPerMillion: input * 1.25,
    outputUsdPerMillion: output,
    ...(proxy ? { proxy: true } : {}),
  };
}

const CLAUDE_PRICES = new Map<string, ApiPriceProfile>([
  ["opus", claude("opus", "claude-opus-4.6", 5, 25, true)],
  ["sonnet", claude("sonnet", "claude-sonnet-4.6", 3, 15, true)],
  ["haiku", claude("haiku", "claude-haiku-4.5", 1, 5, true)],
  ["claude-opus-4-6", claude("claude-opus-4-6", "claude-opus-4.6", 5, 25, false)],
  ["claude-sonnet-4-6", claude("claude-sonnet-4-6", "claude-sonnet-4.6", 3, 15, false)],
  ["claude-haiku-4-5", claude("claude-haiku-4-5", "claude-haiku-4.5", 1, 5, false)],
]);

export function codexApiPriceProfile(model?: string): ApiPriceProfile | undefined {
  if (!model) {
    const profile = CODEX_PRICES.get("gpt-5.6-sol")!;
    return { ...profile, id: "codex-default", proxy: true };
  }
  return CODEX_PRICES.get(model);
}

export function claudeApiPriceProfile(model?: string): ApiPriceProfile | undefined {
  if (!model) {
    const profile = CLAUDE_PRICES.get("sonnet")!;
    return { ...profile, id: "claude-default", proxy: true };
  }
  return CLAUDE_PRICES.get(model);
}
