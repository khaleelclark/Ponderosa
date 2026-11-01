import type { AgentEvent, TokenUsage } from "@ponderosa/core";

type Done = Extract<AgentEvent, { type: "turn_done" }>;
type Work = Extract<AgentEvent, { type: "work_item_update" }>;
interface Task { id: string; run?: string; kind: string; }
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Keep accepted native work inside the original managed Run and its fence.
 * Native clocks remain native; summaries never become new prompts or Requests. */
export class ClaudeTaskLifetime {
  readonly stopCallbackId: string;
  private open = false;
  private stateSeen = false;
  private obligationsSeen = false;
  private pending?: Done;
  private scheduleReceiptPending = false;
  private readonly tasks = new Map<string, Task>();
  private readonly background = new Map<string, Task>();
  private readonly crons = new Set<string>();
  private readonly resultIds = new Set<string>();
  private readonly latest = new Map<string, Task>();
  private readonly ended = new Set<string>();

  constructor(private readonly sessionId: string) {
    if (!identity(sessionId)) throw new Error("Invalid native lifetime session");
    this.stopCallbackId = `ponderosa-lifetime-${sessionId}`;
  }

  get ownsRun(): boolean { return this.open; }

  beginTurn(): void {
    if (this.open) throw new Error("Native work still owns the managed Run");
    this.open = true;
    this.pending = undefined;
    this.obligationsSeen = false;
    this.latest.clear();
    this.ended.clear();
  }

  /** Only the registered callback for this exact native session is consumed. */
  stopHook(raw: unknown): { requestId: string; events: AgentEvent[] } | undefined {
    const envelope = record(raw), request = record(envelope?.request), input = record(request?.input);
    if (envelope?.type !== "control_request" || request?.subtype !== "hook_callback" ||
        request.callback_id !== this.stopCallbackId || !identity(envelope.request_id) ||
        input?.session_id !== this.sessionId || input.hook_event_name !== "Stop") return undefined;
    const events: AgentEvent[] = [];
    if (this.open) {
      // Missing fields on older producers are not evidence that work ended.
      if (input.session_crons !== undefined) {
        if (!Array.isArray(input.session_crons) || input.session_crons.length > 1000) throw new Error("Invalid native schedule snapshot");
        const next = new Set<string>();
        for (const value of input.session_crons) {
          const cron = record(value);
          if (!identity(cron?.id)) throw new Error("Invalid native schedule identity");
          next.add(cron.id);
        }
        for (const id of this.crons) if (!next.has(id)) events.push(this.work({ id, kind: "schedule" }, "done"));
        for (const id of next) if (!this.crons.has(id)) events.push(this.work({ id, kind: "schedule" }, "running"));
        if (this.scheduleReceiptPending) {
          events.push(this.work({ id: "receipt-pending", kind: "schedule-contract" }, "done"));
          this.scheduleReceiptPending = false;
        }
        this.crons.clear();
        for (const id of next) this.crons.add(id);
        if (next.size) this.obligationsSeen = true;
      }
      if (input.background_tasks !== undefined) {
        if (!Array.isArray(input.background_tasks) || input.background_tasks.length > 1000) throw new Error("Invalid native Stop task snapshot");
        for (const value of input.background_tasks) {
          const task = record(value);
          if (!identity(task?.id) || !identity(task.type)) throw new Error("Invalid native Stop task identity");
          if (task.status === "running" || task.status === "pending" || task.status === "paused") {
            // A hook summary has no run_id: do not replace a stronger edge identity.
            if (!this.tasks.has(task.id) && !this.background.has(task.id)) {
              const accepted = { id: task.id, kind: task.type };
              this.tasks.set(task.id, accepted);
              events.push(this.work(accepted, "running"));
            }
            this.obligationsSeen = true;
          }
        }
      }
    }
    this.bound();
    return { requestId: envelope.request_id, events };
  }

  observe(raw: unknown): AgentEvent[] {
    const value = record(raw);
    if (!this.open || value?.session_id !== this.sessionId || value.isReplay === true) return [];
    const events: AgentEvent[] = [];
    if (value.type === "assistant" && value.parent_tool_use_id === null) {
      const content = record(value.message)?.content;
      if (Array.isArray(content) && content.some(item => {
        const block = record(item);
        return block?.type === "tool_use" && ["CronCreate", "CronDelete", "ScheduleWakeup"].includes(String(block.name));
      })) {
        // Intent is NOT an accepted job. Retain authority until the native Stop snapshot resolves it.
        if (!this.scheduleReceiptPending) events.push(this.work({ id: "receipt-pending", kind: "schedule-contract" }, "running"));
        this.scheduleReceiptPending = true;
        this.obligationsSeen = true;
      }
      return events;
    }
    if (value.type !== "system") return [];
    if (value.subtype === "session_state_changed") {
      if (!["idle", "running", "requires_action"].includes(String(value.state))) throw new Error("Invalid native session state");
      this.stateSeen = true;
      // Only idle AFTER the latest result closes the native continuation gap.
      if (value.state === "idle" && this.pending && !this.tasks.size && !this.background.size && !this.crons.size && !this.scheduleReceiptPending) {
        events.push(this.pending);
        this.pending = undefined;
        this.open = false;
      }
    } else if (value.subtype === "background_tasks_changed") {
      if (!Array.isArray(value.tasks) || value.tasks.length > 1000) throw new Error("Invalid native task snapshot");
      const next = new Map<string, Task>();
      for (const item of value.tasks) {
        const task = record(item);
        if (!identity(task?.task_id) || !identity(task.task_type) || task.run_id !== undefined && !identity(task.run_id)) throw new Error("Invalid native task identity");
        const accepted: Task = { id: task.task_id, kind: task.task_type, ...(task.run_id ? { run: task.run_id as string } : {}) };
        if (this.stale(accepted) || this.ended.has(this.key(accepted))) continue;
        const edge = this.tasks.get(accepted.id);
        if (edge && !this.same(edge, accepted)) {
          events.push(this.work(edge, "done"));
          this.tasks.set(accepted.id, accepted);
        }
        this.latest.set(accepted.id, accepted);
        next.set(accepted.id, accepted);
        if (!this.same(this.background.get(accepted.id), accepted)) events.push(this.work(accepted, "running"));
      }
      for (const [id, prior] of this.background) {
        const replacement = next.get(id);
        if ((!replacement || !this.same(prior, replacement)) && !this.tasks.has(id)) events.push(this.work(prior, "done"));
      }
      this.background.clear();
      for (const [id, task] of next) this.background.set(id, task);
      // This level contains background work only. Never narrow foreground edges against it.
      if (next.size) this.obligationsSeen = true;
    } else if (value.subtype === "task_started") {
      if (!identity(value.task_id) || value.run_id !== undefined && !identity(value.run_id)) throw new Error("Invalid native task start");
      if (value.task_type !== undefined && !identity(value.task_type)) throw new Error("Invalid native task type");
      const accepted: Task = { id: value.task_id, kind: identity(value.task_type) ? value.task_type : "task", ...(value.run_id ? { run: value.run_id as string } : {}) };
      if (this.stale(accepted) || this.ended.has(this.key(accepted))) return [];
      const prior = this.tasks.get(accepted.id);
      this.latest.set(accepted.id, accepted);
      if (!this.same(prior, accepted)) {
        if (prior) events.push(this.work(prior, "done"));
        events.push(this.work(accepted, "running"));
      }
      this.tasks.set(accepted.id, accepted);
      this.obligationsSeen = true;
    } else if (value.subtype === "task_notification" || value.subtype === "task_updated") {
      if (!identity(value.task_id) || value.run_id !== undefined && !identity(value.run_id)) throw new Error("Invalid native task completion");
      const prior = this.tasks.get(value.task_id) ?? this.background.get(value.task_id);
      if (!prior || prior.run !== value.run_id) return [];
      const status = value.subtype === "task_notification" ? value.status : record(value.patch)?.status;
      if (["completed", "failed", "stopped", "killed"].includes(String(status))) {
        this.ended.add(this.key(prior));
        this.tasks.delete(value.task_id);
        this.background.delete(value.task_id);
        events.push({ ...this.work(prior, "done"), title: `${this.work(prior, "done").title}: ${String(status)}` });
      }
    }
    this.bound();
    return events;
  }

  project(event: AgentEvent, raw: unknown): AgentEvent[] {
    if (event.type !== "turn_done") return [event];
    const envelope = record(raw);
    if (!this.open || envelope?.session_id !== this.sessionId || envelope.isReplay === true) return [];
    if (identity(envelope.uuid)) {
      if (this.resultIds.has(envelope.uuid)) return [];
      if (this.resultIds.size >= 1000) throw new Error("Native result identity retention limit reached");
      this.resultIds.add(envelope.uuid);
    }
    if (!this.stateSeen && !this.obligationsSeen) {
      // Older producers without lifecycle signals retain ordinary-turn behavior.
      this.open = false;
      return [event];
    }
    const usage: TokenUsage = { ...this.pending?.usage };
    for (const [key, amount] of Object.entries(event.usage ?? {})) {
      if (typeof amount === "number") {
        const name = key as keyof TokenUsage;
        const total = (usage[name] ?? 0) + amount;
        if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid native lifetime usage");
        usage[name] = total;
      }
    }
    this.pending = { type: "turn_done", usage };
    return [];
  }

  private stale(task: Task): boolean {
    const prior = this.latest.get(task.id);
    return Boolean(prior?.run && (!task.run || task.run < prior.run));
  }
  private key(task: Task): string {
    return `native:${JSON.stringify([this.sessionId, task.kind, task.id, task.run ?? null])}`;
  }
  private same(left: Task | undefined, right: Task): boolean {
    return left?.id === right.id && left.run === right.run && left.kind === right.kind;
  }
  private work(task: Task, status: Work["status"]): Work {
    return { type: "work_item_update", workItemId: this.key(task),
      status, title: `Native ${task.kind}: ${task.id}${task.run ? ` (${task.run})` : ""}` };
  }
  private bound(): void {
    if (this.tasks.size + this.background.size + this.crons.size > 1000 || this.latest.size > 1000 || this.ended.size > 1000) throw new Error("Native work lifetime exceeded the retained identity limit");
  }
}
