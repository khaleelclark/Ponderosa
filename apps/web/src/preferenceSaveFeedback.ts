import type {WorkspacePreferencesDto} from "@ponderosa/core";

/** Feedback follows each saved field, independently of the canonical write queue. */
export class PreferenceSaveFeedback {
  private nextAttempt = 0;
  private settled = new Map<string, number>();
  private failures = new Map<string, unknown>();

  async track<T>(patch: Partial<WorkspacePreferencesDto>, write: Promise<T>,
    report: (field: string, error?: string) => void, immediate: boolean,
    previous?: Partial<WorkspacePreferencesDto>): Promise<T> {
    const attempt = ++this.nextAttempt;
    const fields: {field: string; value: unknown; changed: boolean}[] = [];
    const collect = (field: string, value: unknown, before: unknown): void => {
      if ((value && typeof value === "object") || (before && typeof before === "object")) {
        const after = value as Record<string, unknown> | undefined;
        const prior = before as Record<string, unknown> | undefined;
        for (const key of new Set([...Object.keys(prior ?? {}), ...Object.keys(after ?? {})])) {
          collect(`${field}.${key}`, after?.[key], prior?.[key]);
        }
      } else fields.push({field, value, changed: value !== before});
    };
    for (const [field, value] of Object.entries(patch)) {
      if (field === "revision" || field.endsWith("Revision")) continue;
      // Atomic nested writes still contain unchanged sibling controls.
      if (field === "notifications" || field === "engineDefaults") collect(field, value, previous?.[field]);
      else fields.push({field, value, changed: true});
    }
    const settle = (error?: string) => {
      for (const {field, value, changed} of fields) {
        if (!changed && !(this.failures.has(field) && this.failures.get(field) === value)) continue;
        if ((this.settled.get(field) ?? 0) > attempt) continue;
        this.settled.set(field, attempt);
        if (error) {
          if (immediate) { this.failures.set(field, value); report(field, error); }
        } else {
          const failed = this.failures.delete(field);
          if (immediate || failed) report(field);
        }
      }
    };
    try { const value = await write; settle(); return value; }
    catch (error) {
      settle(error instanceof Error ? error.message : "Workspace settings could not be saved.");
      throw error;
    }
  }
}
