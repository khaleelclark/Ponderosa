import type { NativeTask, NativeTaskStopOutcome } from "@ponderosa/core";
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Pinned experimental app-server contract. No shell PID, title or command matching. */
export class CodexBackgroundTasks {
  private inventory = new Map<string, NativeTask>();
  private listing?: Promise<NativeTask[]>;
  constructor(private readonly threadId: string,
    private readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {}

  list(): Promise<NativeTask[]> {
    if (this.listing) return this.listing;
    const operation = this.read();
    this.listing = operation;
    void operation.then(() => { this.listing = undefined; }, () => { this.listing = undefined; });
    return operation;
  }

  private async read(): Promise<NativeTask[]> {
    try {
      const tasks = new Map<string, NativeTask>(), cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const response = object(await this.request("thread/backgroundTerminals/list", {
          threadId: this.threadId, limit: 100, ...(cursor ? { cursor } : {}),
        }));
        if (!response || !Array.isArray(response.data) || response.data.length > 100) throw new Error("Invalid native terminal page");
        for (const value of response.data) {
          const row = object(value);
          if (!id(row?.itemId) || !id(row.processId)) throw new Error("Invalid native terminal identity");
          const taskKey = JSON.stringify([this.threadId, row.itemId, row.processId]);
          if (tasks.has(taskKey) || tasks.size >= 1000) throw new Error("Duplicate or excessive native terminal inventory");
          tasks.set(taskKey, { taskKey, taskId: row.processId, itemId: row.itemId,
            processId: row.processId, kind: "background_terminal", cancellable: true });
        }
        if (response.nextCursor === null || response.nextCursor === undefined) {
          this.inventory = tasks;
          return [...tasks.values()];
        }
        if (!id(response.nextCursor) || cursors.has(response.nextCursor)) throw new Error("Invalid native terminal cursor");
        cursor = response.nextCursor; cursors.add(cursor);
      }
      throw new Error("Native terminal pagination limit reached");
    } catch (error) { this.inventory.clear(); throw error; }
  }

  async stop(taskKey: string): Promise<NativeTaskStopOutcome> {
    const task = this.inventory.get(taskKey);
    if (!task) throw new Error("Refresh exact owned native terminal inventory before stopping");
    // Consume before input; a lost acknowledgement never permits a second mutation.
    this.inventory.delete(taskKey);
    try {
      const response = object(await this.request("thread/backgroundTerminals/terminate", {
        threadId: this.threadId, processId: task.processId,
      }));
      return response?.terminated === true ? "terminated" : response?.terminated === false ? "not_found" : "unknown";
    } catch { return "unknown"; }
  }
}
