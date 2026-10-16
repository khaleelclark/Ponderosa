import { deflateRawSync, inflateRawSync } from "node:zlib";
import { PONDEROSA_RUNTIME_TOOLS, PONDEROSA_MEMORY_TOOLS, PONDEROSA_HISTORY_TOOL, type RuntimeDynamicToolSpec } from "@ponderosa/core";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_ENCODED_CHARACTERS = 16 * 1024;
const knownNames = new Set([...PONDEROSA_RUNTIME_TOOLS, ...PONDEROSA_MEMORY_TOOLS, PONDEROSA_HISTORY_TOOL].map(tool => tool.name));

function validTools(value: unknown): value is RuntimeDynamicToolSpec[] {
  if (!Array.isArray(value) || value.length > knownNames.size) return false;
  const names = new Set<string>();
  for (const tool of value) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) ||
        Object.keys(tool).length !== 3 || typeof tool.name !== "string" || !knownNames.has(tool.name) || names.has(tool.name) ||
        typeof tool.description !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object" ||
        Array.isArray(tool.inputSchema) || tool.inputSchema.type !== "object") return false;
    names.add(tool.name);
  }
  const pending = [{ value: value as unknown, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 4096 || item.depth > 16) return false;
    if (typeof item.value === "string" && (item.value.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item.value))) return false;
    if (typeof item.value === "number" && !Number.isFinite(item.value)) return false;
    if (item.value && typeof item.value === "object") {
      for (const [key, child] of Object.entries(item.value)) {
        if (key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key)) return false;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return true;
}

/** Absent means legacy standalone MCP; malformed supplied data fails closed,
 * never falling back to this build's broader/different canonical definitions. */
export function decodeSessionTools(raw: string | undefined): RuntimeDynamicToolSpec[] | undefined {
  if (raw === undefined) return undefined;
  try {
    if (!raw || raw.length > MAX_ENCODED_CHARACTERS || raw.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(raw)) return [];
    const compressed = Buffer.from(raw, "base64");
    if (compressed.toString("base64") !== raw) return [];
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflateRawSync(compressed, { maxOutputLength: MAX_JSON_BYTES })));
    return validTools(value) ? value : [];
  } catch { return []; }
}

/** Compact session data avoids putting the full schema set on Claude's command
 * line. Both compressed transport and decompressed JSON have fixed ceilings. */
export function encodeSessionTools(tools: readonly RuntimeDynamicToolSpec[]): string {
  const json = JSON.stringify(tools);
  if (Buffer.byteLength(json) > MAX_JSON_BYTES || !validTools(JSON.parse(json))) throw new Error("invalid MCP session tool definitions");
  const encoded = deflateRawSync(json).toString("base64");
  if (encoded.length > MAX_ENCODED_CHARACTERS) throw new Error("MCP session tool definitions exceed transport limit");
  return encoded;
}
