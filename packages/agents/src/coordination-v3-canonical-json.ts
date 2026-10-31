import { createHash } from "node:crypto";
import { agentPackageJsonPieces } from "@ponderosa/core";

const DEFAULT_CANONICAL_JSON_LIMITS = { maxDepth: 512, maxNodes: 1_000_000 } as const;

/** Deterministic JSON without recursive descent. External signed JSON can be
 * deeply nested even under the byte limit, so canonicalization is explicitly
 * bounded by both structure depth and visited nodes. */
function* stableJsonParts(
  value: unknown,
  limits: { maxDepth: number; maxNodes: number } = DEFAULT_CANONICAL_JSON_LIMITS,
): Generator<string> {
  type Task = { kind: "value"; value: unknown; depth: number } | { kind: "text"; value: string }
    | { kind: "array"; value: unknown[]; index: number; depth: number }
    | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number; depth: number };
  const tasks: Task[] = [{ kind: "value", value, depth: 0 }];
  let nodes = 0;
  let scheduledNodes = 1;
  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.kind === "text") {
      yield task.value;
      continue;
    }
    if (task.kind === "array") {
      if (task.index >= task.value.length) continue;
      const index = task.index++;
      tasks.push(task, { kind: "value", value: task.value[index] ?? null, depth: task.depth });
      if (index > 0) tasks.push({ kind: "text", value: "," });
      continue;
    }
    if (task.kind === "object") {
      if (task.index >= task.keys.length) continue;
      const index = task.index++, key = task.keys[index]!;
      tasks.push(task, { kind: "value", value: task.value[key], depth: task.depth },
        { kind: "text", value: ":" }, { kind: "text", value: JSON.stringify(key) });
      if (index > 0) tasks.push({ kind: "text", value: "," });
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes) throw new Error(`canonical JSON exceeds ${limits.maxNodes} nodes`);
    if (task.depth > limits.maxDepth) throw new Error(`canonical JSON exceeds maximum depth ${limits.maxDepth}`);
    if (Array.isArray(task.value)) {
      if (scheduledNodes + task.value.length > limits.maxNodes) throw new Error(`canonical JSON exceeds ${limits.maxNodes} nodes`);
      scheduledNodes += task.value.length;
      tasks.push({ kind: "text", value: "]" }, { kind: "array", value: task.value, index: 0, depth: task.depth + 1 });
      yield "[";
      continue;
    }
    if (task.value && typeof task.value === "object") {
      const record = task.value as Record<string, unknown>;
      const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
      if (scheduledNodes + keys.length > limits.maxNodes) throw new Error(`canonical JSON exceeds ${limits.maxNodes} nodes`);
      scheduledNodes += keys.length;
      tasks.push({ kind: "text", value: "}" }, { kind: "object", value: record, keys, index: 0, depth: task.depth + 1 });
      yield "{";
      continue;
    }
    // The portable codec already owns bounded, surrogate-safe JSON strings.
    if (typeof task.value === "string") yield* agentPackageJsonPieces(task.value);
    else yield JSON.stringify(task.value) ?? "null";
  }
}

function stableJson(
  value: unknown,
  limits: { maxDepth: number; maxNodes: number } = DEFAULT_CANONICAL_JSON_LIMITS,
): string {
  return [...stableJsonParts(value, limits)].join("");
}

function payloadHash(
  value: unknown,
  limits?: { maxDepth: number; maxNodes: number },
): string {
  const hash = createHash("sha256");
  for (const part of stableJsonParts(value, limits)) hash.update(part);
  return hash.digest("hex");
}

export { payloadHash, stableJson, stableJsonParts };
