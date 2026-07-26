import type { TokenUsageRangeDto } from "@ponderosa/core";

export function parseTokenUsageRange(query: { from?: string; to?: string }): TokenUsageRangeDto {
  const range: TokenUsageRangeDto = {};
  for (const key of ["from", "to"] as const) {
    const value = query[key];
    if (value === undefined) continue;
    const timestamp = new Date(value);
    if (!value.trim() || Number.isNaN(timestamp.valueOf())) throw new Error(`${key} must be a valid ISO timestamp`);
    range[key] = timestamp.toISOString();
  }
  if (range.from && range.to && range.from >= range.to) throw new Error("from must be earlier than to");
  return range;
}
