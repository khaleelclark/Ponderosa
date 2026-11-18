import type { AgentEvent, EngineCommand, NativeGoalSnapshot, NativeTurnAction, RuntimeCommandResult } from "@ponderosa/core";

interface NativeRpc { request<T = unknown>(method: string, params: unknown): Promise<T> }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native operation response");
  return value as Record<string, unknown>;
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid native goal accounting");
  return value as number;
};
export function codexGoalSnapshot(value: unknown, threadId: string): NativeGoalSnapshot | null {
  if (value === null) return null;
  const row = record(value);
  if (row.threadId !== threadId || typeof row.objective !== "string" || !row.objective.trim() || row.objective.length > 32_000 ||
      !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(row.status))) throw new Error("Invalid native goal snapshot");
  return { threadId, objective: row.objective, status: row.status as NativeGoalSnapshot["status"],
    tokenBudget: row.tokenBudget === null ? null : count(row.tokenBudget), tokensUsed: count(row.tokensUsed),
    timeUsedSeconds: count(row.timeUsedSeconds), createdAt: count(row.createdAt), updatedAt: count(row.updatedAt) };
}

function goalMessage(goal: NativeGoalSnapshot): string {
  return `${goal.objective.slice(0, 2000)}${goal.objective.length > 2000 ? "…" : ""}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? "unlimited"}\nTime: ${goal.timeUsedSeconds}s`;
}

export function codexNativeCommands(hasSession: boolean): EngineCommand[] {
  return [
    ["goal", "Inspect native objective, status, token budget and usage", false, "runtime"],
    ["goal-create", 'Create a native goal: {"objective":"…","tokenBudget":10000}', true, "prompt"],
    ["goal-edit", 'Edit a paused native goal: {"objective":"…","tokenBudget":10000}', true, "runtime"],
    ["goal-pause", "Pause the retained native goal", false, "runtime"],
    ["goal-clear", "Clear the retained native goal", false, "runtime"],
    ["goal-resume", "Resume native goal continuation", false, "prompt"],
    ["plan", 'Native plan mode: {"prompt":"…","mode":"plan"} (or "default")', true, "prompt"],
    ["review", 'Native review target: {"type":"uncommittedChanges"}, baseBranch, commit or custom', true, "prompt"],
    ["structured", 'Schema-constrained turn: {"prompt":"…","schema":{…}}', true, "prompt"],
  ].map<EngineCommand>(([name, description, acceptsArguments, invocation]) => {
    const unavailableReason = !hasSession && name !== "goal-create" && String(name).startsWith("goal")
      ? "Requires an accepted retained Codex session." : undefined;
    return { name: name as string, description: description as string, acceptsArguments: acceptsArguments as boolean,
      invocation: invocation as "runtime" | "prompt", source: "adapter-implemented", insertText: `/${name}${acceptsArguments ? " " : ""}`,
      status: unavailableReason ? "unavailable" : "available", ...(unavailableReason ? { unavailableReason } : {}) };
  });
}

/** Only the human provider-command endpoint calls these operations. No tool or
 * prose-derived intent may set origin:user. Never activate native idle loops. */
export async function invokeCodexGoal(rpc: NativeRpc, threadId: string, name: string, argumentsText?: string): Promise<RuntimeCommandResult> {
  if (name === "goal-resume") throw new Error("Scheduler-bound native goal continuation is not implemented");
  if (name !== "goal-edit" && argumentsText?.trim()) throw new Error(`/${name} does not accept arguments`);
  if (name === "goal") {
    const goal = codexGoalSnapshot(record(await rpc.request("thread/goal/get", { threadId })).goal, threadId);
    return { goal, message: goal ? goalMessage(goal) : "This native session has no goal." };
  }
  let params: Record<string, unknown> = { threadId, origin: "user" };
  if (name === "goal-edit") {
    if (!argumentsText || argumentsText.length > 40_000) throw new Error("Goal editing requires bounded JSON arguments");
    const input = record(JSON.parse(argumentsText));
    if (Object.keys(input).some(key => key !== "objective" && key !== "tokenBudget") || !Object.keys(input).length) throw new Error("Supply objective and/or tokenBudget; status and origin cannot be supplied");
    if (input.objective !== undefined && (typeof input.objective !== "string" || !input.objective.trim() || input.objective.length > 32_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input.objective))) throw new Error("A nonempty bounded objective is required");
    if (Object.hasOwn(input, "tokenBudget") && input.tokenBudget !== null && (count(input.tokenBudget) === 0)) throw new Error("Token budget must be positive or null");
    // Explicit paused status prevents default-active creation and prevents edits
    // to an existing active goal from injecting unscheduled work.
    params = { ...params, ...input, status: "paused" };
  } else if (name === "goal-pause") params.status = "paused";
  else if (name !== "goal-clear") throw new Error("Unknown native goal operation");
  try {
    if (name === "goal-clear") {
      const result = record(await rpc.request("thread/goal/clear", params));
      if (typeof result.cleared !== "boolean") throw new Error("Invalid native clear response");
      return { outcome: "completed", goalCleared: result.cleared, message: result.cleared ? "Native goal cleared." : "This native session has no goal to clear." };
    }
    const goal = codexGoalSnapshot(record(await rpc.request("thread/goal/set", params)).goal, threadId);
    if (!goal || goal.status !== "paused") throw new Error("Native goal pause was not confirmed");
    return { outcome: "completed", goal, message: goalMessage(goal) };
  } catch {
    // No mutation retry: transport failure or malformed response may follow a commit.
    return { outcome: "outcome_unknown", message: "Native goal operation outcome is unconfirmed. Inspect /goal before taking another action; do not replay the mutation." };
  }
}

export async function setCodexPlanMode(rpc: NativeRpc, threadId: string,
  action: Extract<NativeTurnAction, {kind: "plan"}>, model: string, effort?: string): Promise<void> {
  const response = record(await rpc.request("thread/settings/update", { threadId,
    collaborationMode: { mode: action.mode, settings: { model,
      reasoning_effort: effort ?? null, developer_instructions: null } } }));
  if (Object.keys(response).length) throw new Error("Invalid native plan-settings acknowledgement");
}

/** A review creates a provider turn, so it is admitted only by startTurn under
 * the scheduler's existing Run, lease, cancellation and event fences. */
export async function startCodexReview(rpc: NativeRpc, threadId: string, action: Extract<NativeTurnAction, {kind: "review"}>): Promise<string> {
  const response = record(await rpc.request("review/start", { threadId, target: action.target, delivery: "inline" }));
  const turn = record(response.turn);
  if (response.reviewThreadId !== threadId || typeof turn.id !== "string" || !turn.id) throw new Error("Native review did not confirm the exact retained thread and turn");
  return turn.id;
}

/** Receipts belong to the exact current provider thread/turn. Replayed or
 * foreign notifications must never enter another Run's execution projection. */
export function codexNativeObservation(method: string, params: unknown, threadId: string, turnId: string | undefined): AgentEvent[] {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const row = params as Record<string, unknown>;
  if (!turnId || row.threadId !== threadId || row.turnId !== turnId) return [];
  if (method === "turn/plan/updated") {
    if (!Array.isArray(row.plan) || row.plan.length > 1_000 || row.explanation !== null && typeof row.explanation !== "string") throw new Error("Invalid native plan observation");
    const steps = row.plan.map(value => {
      const step = record(value);
      if (typeof step.step !== "string" || !["pending", "inProgress", "completed"].includes(String(step.status))) throw new Error("Invalid native plan step");
      return { step: step.step, status: step.status as "pending" | "inProgress" | "completed" };
    });
    return [{ type: "native_plan", providerTurnId: turnId, ...(typeof row.explanation === "string" ? { explanation: row.explanation } : {}), steps }];
  }
  if (method === "turn/diff/updated") {
    if (typeof row.diff !== "string") throw new Error("Invalid native diff observation");
    return [{ type: "native_diff", providerTurnId: turnId, diff: row.diff }];
  }
  if (method === "item/completed") {
    const item = record(row.item);
    if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      if (typeof item.review !== "string") throw new Error("Invalid native review observation");
      return [{ type: "native_review", providerTurnId: turnId,
        phase: item.type === "enteredReviewMode" ? "started" : "completed", text: item.review }];
    }
  }
  return [];
}
