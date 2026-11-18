/** Human-selected native work. These are execution options, never instructions
 * inferred from an Agent's prose or a request to create autonomous work. */
export type NativeReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

export type NativeTurnAction =
  | { kind: "goal-resume" }
  | { kind: "goal-create"; objective: string; tokenBudget?: number | null }
  | { kind: "review"; target: NativeReviewTarget }
  | { kind: "plan"; mode: "plan" | "default"; prompt: string }
  | { kind: "structured"; outputSchema: Record<string, unknown>; prompt: string };

export interface NativeGoalSnapshot {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid native command fields");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) throw new Error("A bounded nonempty native command value is required");
  return value;
}
export function nativeReviewTarget(value: unknown): NativeReviewTarget {
  const row = record(value, ["type", "branch", "sha", "title", "instructions"]);
  switch (row.type) {
    case "uncommittedChanges": record(row, ["type"]); return { type: row.type };
    case "baseBranch": record(row, ["type", "branch"]); return { type: row.type, branch: text(row.branch) };
    case "commit":
      record(row, ["type", "sha", "title"]);
      if (typeof row.sha !== "string" || !/^[0-9a-f]{7,64}$/iu.test(row.sha)) throw new Error("Review commit must be a hexadecimal commit identity");
      return { type: row.type, sha: row.sha, title: row.title == null ? null : text(row.title) };
    case "custom": record(row, ["type", "instructions"]); return { type: row.type, instructions: text(row.instructions) };
    default: throw new Error("Unknown native review target");
  }
}

/** Call only on the exact canonical human message; never on assembled context,
 * historical messages, agent-authored content, or revised display text. */
export function parseNativeTurnCommand(input: string): NativeTurnAction | undefined {
  if (input.trim() === "/goal-resume") return { kind: "goal-resume" };
  if (input.trim() === "/goal-create") throw new Error("Goal creation requires bounded JSON arguments");
  const createGoal = /^\/goal-create\s+([\s\S]+)$/u.exec(input.trim());
  if (createGoal) {
    if (createGoal[1]!.length > 40_000) throw new Error("Goal creation requires bounded JSON arguments");
    const row = record(JSON.parse(createGoal[1]!), ["objective", "tokenBudget"]);
    const objective = text(row.objective);
    if (Object.hasOwn(row, "tokenBudget") && row.tokenBudget !== null &&
        (!Number.isSafeInteger(row.tokenBudget) || (row.tokenBudget as number) <= 0))
      throw new Error("Goal token budget must be a positive integer or null");
    return { kind: "goal-create", objective,
      ...(Object.hasOwn(row, "tokenBudget") ? { tokenBudget: row.tokenBudget as number | null } : {}) };
  }
  const match = /^\/(review|plan|structured)(?:\s+([\s\S]+))?$/u.exec(input.trim());
  if (!match) return undefined;
  if (!match[2] || match[2].length > 64_000) throw new Error(`/${match[1]} requires bounded JSON arguments`);
  const value: unknown = JSON.parse(match[2]);
  if (match[1] === "review") return { kind: "review", target: nativeReviewTarget(value) };
  if (match[1] === "plan") {
    const row = record(value, ["prompt", "mode"]);
    if (row.mode !== undefined && row.mode !== "plan" && row.mode !== "default") throw new Error("Plan mode must be plan or default");
    return { kind: "plan", mode: row.mode ?? "plan", prompt: text(row.prompt) };
  }
  const row = record(value, ["prompt", "schema"]);
  if (!row.schema || typeof row.schema !== "object" || Array.isArray(row.schema)) throw new Error("Structured output requires a JSON Schema object");
  // JSON parsing provides accessor-free JSON; bound nesting before provider input.
  const visit = (node: unknown, depth: number): void => {
    if (depth > 16) throw new Error("JSON Schema is too deeply nested");
    if (node && typeof node === "object") for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(row.schema, 0);
  return { kind: "structured", outputSchema: row.schema as Record<string, unknown>, prompt: text(row.prompt) };
}
