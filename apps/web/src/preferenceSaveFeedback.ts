import type {WorkspacePreferencesDto} from "@ponderosa/core";

/** Feedback follows each saved field, independently of the canonical write queue. */
export class PreferenceSaveFeedback {
  private nextAttempt = 0;
  private settled = new Map<string, number>();
  private failures = new Set<string>();

  async track<T>(patch: Partial<WorkspacePreferencesDto>, write: Promise<T>,
    report: (field: string, error?: string) => void, immediate: boolean): Promise<T> {
    const attempt = ++this.nextAttempt;
    const fields = Object.keys(patch).filter(field => field !== "revision" && !field.endsWith("Revision"));
    const settle = (error?: string) => {
      for (const field of fields) {
        if ((this.settled.get(field) ?? 0) > attempt) continue;
        this.settled.set(field, attempt);
        if (error) {
          if (immediate) { this.failures.add(field); report(field, error); }
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
