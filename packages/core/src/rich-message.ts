/** Presentation data only. Authored Markdown remains the stored/copyable source. */
export type RichMessageBlock = { version: 1; title?: string } & (
  | { type: "metrics"; items: { label: string; value: string; unit?: string; note?: string }[] }
  | { type: "statuses"; items: { label: string; value: string; tone: "neutral" | "positive" | "caution" | "negative"; note?: string }[] }
  | { type: "meters"; items: { label: string; value: number; min: number; max: number; unit: string; note?: string }[] }
  | { type: "bar" | "line"; title: string; unit: string; points: { label: string; value: number }[] }
);

export const RICH_MESSAGE_MAX_BLOCKS = 8;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const optionalText = (value: unknown, max: number) => value === undefined || text(value, max);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const items = (value: unknown, max: number, valid: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.length > 0 && value.length <= max && value.every(item => record(item) && valid(item));

export function parseRichMessageBlock(source: string): RichMessageBlock | undefined {
  if (source.length > 32_768) return undefined;
  let block: unknown;
  try { block = JSON.parse(source); } catch { return undefined; }
  if (!record(block) || block.version !== 1 || !optionalText(block.title, 160)) return undefined;
  let valid = false;
  if (block.type === "metrics" || block.type === "statuses" || block.type === "meters") {
    if (!keys(block, ["version", "type", "title", "items"])) return undefined;
    const type = block.type;
    valid = items(block.items, type === "meters" ? 8 : 12, item => {
      if (!text(item.label, 160) || !optionalText(item.note, 400)) return false;
      if (type === "metrics") return keys(item, ["label", "value", "unit", "note"]) &&
        text(item.value, 64) && optionalText(item.unit, 32);
      if (type === "statuses") return keys(item, ["label", "value", "tone", "note"]) &&
        text(item.value, 64) && typeof item.tone === "string" && ["neutral", "positive", "caution", "negative"].includes(item.tone);
      return keys(item, ["label", "value", "min", "max", "unit", "note"]) &&
        text(item.unit, 32) && finite(item.value) && finite(item.min) && finite(item.max) &&
        item.min < item.max && Number.isFinite(item.max - item.min) && item.value >= item.min && item.value <= item.max;
    });
  } else if (block.type === "bar" || block.type === "line") {
    if (!keys(block, ["version", "type", "title", "unit", "points"]) || !text(block.title, 160) || !text(block.unit, 32)) return undefined;
    const type = block.type;
    valid = items(block.points, 48, point => keys(point, ["label", "value"]) &&
      text(point.label, 160) && finite(point.value) && (type === "line" || point.value >= 0));
    if (valid) {
      const values = (block.points as { value: number }[]).map(point => point.value);
      valid = Number.isFinite(Math.max(...values) - Math.min(...values));
    }
  }
  return valid ? block as RichMessageBlock : undefined;
}

export const RICH_MESSAGE_FORMAT_INSTRUCTIONS = `Use ordinary Markdown by default, including GFM tables (---: aligns a numeric column right). Preserve intentional line breaks and blank lines. Optional data displays use fully closed \`\`\`ponderosa JSON fences, one version:1 display per fence, at most 8 per message. Do not emit HTML, scripts, styles, URLs, or embeds as display fields. Use honest values, units and ranges; a qualitative status is not an invented percentage. Unsupported, invalid or partial blocks remain readable source.
Shapes and examples (no additional keys):
\`\`\`ponderosa
{"version":1,"type":"metrics","title":"Memory","items":[{"label":"Physical RAM","value":"16","unit":"GB","note":"Installed memory"}]}
\`\`\`
\`\`\`ponderosa
{"version":1,"type":"statuses","items":[{"label":"Memory pressure","value":"Low","tone":"positive"}]}
\`\`\`
\`\`\`ponderosa
{"version":1,"type":"meters","items":[{"label":"Readiness","value":18,"min":0,"max":25,"unit":"checks"}]}
\`\`\`
\`\`\`ponderosa
{"version":1,"type":"bar","title":"Completed work","unit":"checks","points":[{"label":"Design","value":6},{"label":"Core","value":7}]}
\`\`\`
\`\`\`ponderosa
{"version":1,"type":"line","title":"Readiness trend","unit":"checks","points":[{"label":"Mon","value":6},{"label":"Tue","value":9}]}
\`\`\`
Titles are optional except on charts. Metric units and all notes are optional. Status tones: neutral, positive, caution, negative. Labels/titles <=160 characters, values <=64, units <=32, notes <=400. At most 12 metrics/statuses, 8 meters, 48 chart points and 32768 characters per block. Meter min<max with value in range; bar values are nonnegative. All numbers and chart spans must be finite.`;
