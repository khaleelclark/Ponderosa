import { branchText } from './branch-definition.js';

/** One deterministic extraction at Map admission; the result is then persisted. */
export function extractBranchMapItems(input: string, source: 'interpret' | 'list' | 'lines', maxItems: number): string[] {
  const text = branchText(input).trim();
  let raw: unknown[];
  if (source === 'list' || (source === 'interpret' && text.startsWith('['))) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('Map expected a JSON list of text items'); }
    if (!Array.isArray(parsed)) throw new Error('Map expected a JSON list of text items');
    raw = parsed;
  } else if (source === 'lines') {
    raw = text ? text.split('\n') : [];
  } else {
    if (!text || /^(?:none|no items|nothing found|no results)[.!]?$/iu.test(text)) return [];
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const marker = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u;
    const first = lines.findIndex(line => marker.test(line));
    if (first < 0) throw new Error('Map could not identify a list in the previous result');
    // Prose introducing a list is fine. A stray line inside or after it is ambiguous.
    if (lines.slice(first).some(line => !marker.test(line))) throw new Error('Map list contains ambiguous text; use one item per bullet or an explicit list');
    raw = lines.slice(first).map(line => marker.exec(line)![1]);
  }
  if (raw.length > maxItems) throw new Error(`Map found ${raw.length} items, above its maxItems limit of ${maxItems}`);
  return raw.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`Map item ${index + 1} must be text`);
    const item = branchText(value).trim();
    if (!item) throw new Error(`Map item ${index + 1} is empty`);
    if (Array.from(item).length > 4096) throw new Error(`Map item ${index + 1} exceeds 4096 characters; use an artifact reference`);
    return item;
  });
}
