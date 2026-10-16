import type { StateReadBudget } from "./state-read-budget.js";

const refuse = (): never => { throw new Error("bounded state buffer refused"); };
/** Plain internally produced receipt values only. No getter/toJSON execution,
 * imported JSON witness, schema/profile permission, or population cache. */
export function boundedStateJson(budget: StateReadBudget, value: unknown, maxBytes = 16 * 1024 ** 2, pretty = true): string {
  let bytes = 2, nodes = 0;
  const add = (size: number): void => {
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes - bytes) refuse();
    bytes += size;
  };
  const visit = (cell: unknown, depth: number): void => {
    budget.reserve(1);
    if (++nodes > 1_000_000 || depth > 128) refuse();
    add(2 * depth + 32); // indentation, framing and separators
    if (cell === null || cell === undefined || typeof cell === "boolean" || typeof cell === "number") return;
    if (typeof cell === "bigint") { if (!pretty) refuse(); add(128); return; }
    if (typeof cell === "string") { budget.reserve(cell.length); add(6 * Buffer.byteLength(cell)); return; }
    if (Buffer.isBuffer(cell)) { add(6 * cell.length + 128); budget.reserve(cell.length); return; }
    if (typeof cell !== "object") refuse();
    if (Array.isArray(cell)) {
      if (cell.length > 1_000_000 - nodes) refuse();
      for (let n = 0; n < cell.length; n++) {
        budget.allocate(128);
        const descriptor = Object.getOwnPropertyDescriptor(cell, String(n));
        if (descriptor && !Object.hasOwn(descriptor, "value")) refuse();
        visit(descriptor?.value, depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(cell);
    if (prototype !== Object.prototype && prototype !== null) refuse();
    for (const key in cell) if (Object.hasOwn(cell, key)) {
      budget.allocate(128); // descriptor/iterator framing BEFORE inspection
      const descriptor = Object.getOwnPropertyDescriptor(cell, key)!;
      if (!Object.hasOwn(descriptor, "value") || key === "toJSON") refuse();
      budget.reserve(key.length);
      add(6 * Buffer.byteLength(key) + 2 * depth + 16);
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  // Working strings, output, verification reread and parse object framing.
  // Engine/V8/GC resident allocations are explicitly additional/unmeasured.
  budget.allocate(128 * bytes + 64 * nodes);
  const encoded = JSON.stringify(value, (_key, cell: unknown) => typeof cell === "bigint" ? cell.toString() : cell, pretty ? 2 : undefined);
  if (encoded === undefined) refuse();
  const result = encoded + (pretty ? "\n" : "");
  if (Buffer.byteLength(result) > bytes) refuse();
  return result;
}

/** Scan syntax bounds before parse allocates arrays/objects. This is a resource
 * guard, never authority or a substitute for the owner's semantic validation. */
export function parseBoundedStateJson(budget: StateReadBudget, text: string, maximum = 16 * 1024 ** 2): unknown {
  const bytes = Buffer.byteLength(text);
  if (bytes > maximum) refuse();
  budget.reserve(1 + text.length); budget.allocate(128 * bytes + 256);
  let depth = 0, separators = 0, quoted = false, escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[" || character === "{") { if (++depth > 128) refuse(); }
    else if (character === "]" || character === "}") { if (--depth < 0) refuse(); }
    else if (character === "," || character === ":") { if (++separators > 1_000_000) refuse(); }
  }
  if (quoted || depth) refuse();
  return JSON.parse(text);
}
