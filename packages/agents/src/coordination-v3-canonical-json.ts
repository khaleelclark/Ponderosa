import { createHash } from "node:crypto";

const DEFAULT_CANONICAL_JSON_LIMITS = { maxDepth: 512, maxNodes: 1_000_000 } as const;

/** Deterministic JSON without recursive descent. External signed JSON can be
 * deeply nested even under the byte limit, so canonicalization is explicitly
 * bounded by both structure depth and visited nodes. */
function stableJson(
  value: unknown,
  limits: { maxDepth: number; maxNodes: number } = DEFAULT_CANONICAL_JSON_LIMITS,
): string {
  type Task = { kind: "value"; value: unknown; depth: number } | { kind: "text"; value: string };
  const tasks: Task[] = [{ kind: "value", value, depth: 0 }];
  const output: string[] = [];
  let nodes = 0;
  let scheduledNodes = 1;
  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.kind === "text") {
      output.push(task.value);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new Error(`canonical JSON exceeds ${limits.maxNodes} nodes`);
    }
    if (task.depth > limits.maxDepth) {
      throw new Error(`canonical JSON exceeds maximum depth ${limits.maxDepth}`);
    }
    if (Array.isArray(task.value)) {
      if (scheduledNodes + task.value.length > limits.maxNodes) {
        throw new Error(`canonical JSON exceeds ${limits.maxNodes} nodes`);
      }
      scheduledNodes += task.value.length;
      tasks.push({ kind: "text", value: "]" });
      for (let index = task.value.length - 1; index >= 0; index -= 1) {
        tasks.push({
          kind: "value",
          value: task.value[index] === undefined ? null : task.value[index],
          depth: task.depth + 1,
        });
        if (index > 0) tasks.push({ kind: "text", value: "," });
      }
      tasks.push({ kind: "text", value: "[" });
      continue;
    }
    if (task.value && typeof task.value === "object") {
      const record = task.value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      if (scheduledNodes + keys.length > limits.maxNodes) {
        throw new Error(`canonical JSON exceeds ${limits.maxNodes} nodes`);
      }
      scheduledNodes += keys.length;
      tasks.push({ kind: "text", value: "}" });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        tasks.push({ kind: "value", value: record[key], depth: task.depth + 1 });
        tasks.push({ kind: "text", value: ":" });
        tasks.push({ kind: "text", value: JSON.stringify(key) });
        if (index > 0) tasks.push({ kind: "text", value: "," });
      }
      tasks.push({ kind: "text", value: "{" });
      continue;
    }
    output.push(JSON.stringify(task.value) ?? "null");
  }
  return output.join("");
}

function payloadHash(
  value: unknown,
  limits?: { maxDepth: number; maxNodes: number },
): string {
  return createHash("sha256").update(stableJson(value, limits)).digest("hex");
}

export { payloadHash, stableJson };
