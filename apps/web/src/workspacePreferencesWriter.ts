import type { WorkspacePreferencesDto } from "@ponderosa/core";

type PreferencePatch = Partial<WorkspacePreferencesDto>;

interface PendingWrite {
  patch: PreferencePatch;
  previous: WorkspacePreferencesDto | undefined;
}

export class WorkspacePreferencesWriter {
  private pending: PendingWrite[] = [];
  private canonical: WorkspacePreferencesDto | undefined;
  private tail = Promise.resolve();

  constructor(private readonly operations: {
    read(): WorkspacePreferencesDto | undefined;
    publish(value: WorkspacePreferencesDto): void;
    write(patch: PreferencePatch): Promise<WorkspacePreferencesDto>;
    refresh(): Promise<WorkspacePreferencesDto>;
    onSuccess?(previous: WorkspacePreferencesDto | undefined, value: WorkspacePreferencesDto, patch: PreferencePatch): void;
    onError?(reason: unknown): void;
  }) {}

  projectCanonical(value: WorkspacePreferencesDto): WorkspacePreferencesDto {
    if (!this.canonical || value.updatedAt >= this.canonical.updatedAt) this.canonical = value;
    return this.projectPending();
  }

  enqueue(patch: PreferencePatch): void {
    const entry = { patch, previous: this.operations.read() };
    this.canonical ??= entry.previous;
    this.pending.push(entry);
    if (this.canonical) this.operations.publish(this.projectPending());
    this.tail = this.tail.then(() => this.commit(entry), () => this.commit(entry));
  }

  private async commit(entry: PendingWrite): Promise<void> {
    try {
      const response = await this.operations.write(entry.patch);
      this.pending = this.pending.filter(candidate => candidate !== entry);
      this.operations.publish(this.projectCanonical(response));
      this.operations.onSuccess?.(entry.previous, response, entry.patch);
    } catch (reason) {
      this.pending = this.pending.filter(candidate => candidate !== entry);
      try {
        this.operations.publish(this.projectCanonical(await this.operations.refresh()));
      } finally {
        this.operations.onError?.(reason);
      }
    }
  }

  private projectPending(): WorkspacePreferencesDto {
    return this.pending.reduce((current, pending) => ({ ...current, ...pending.patch }), this.canonical!);
  }
}
