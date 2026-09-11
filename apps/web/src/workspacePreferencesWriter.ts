import type { WorkspacePreferencesDto } from "@ponderosa/core";

type PreferencePatch = Partial<WorkspacePreferencesDto>;

interface PendingWrite {
  patch: PreferencePatch;
  previous: WorkspacePreferencesDto | undefined;
  resolve?: (value: WorkspacePreferencesDto) => void;
  reject?: (reason: unknown) => void;
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
    if (!this.canonical || value.revision >= this.canonical.revision) this.canonical = value;
    return this.projectPending();
  }

  async fetchCanonical(
    fetch: () => Promise<WorkspacePreferencesDto>,
  ): Promise<WorkspacePreferencesDto> {
    return this.projectCanonical(await fetch());
  }

  enqueue(patch: PreferencePatch): void {
    this.queue({ patch, previous: this.operations.read() });
  }

  enqueueAndWait(patch: PreferencePatch): Promise<WorkspacePreferencesDto> {
    return new Promise((resolve, reject) => {
      this.queue({ patch, previous: this.operations.read(), resolve, reject });
    });
  }

  private queue(entry: PendingWrite): void {
    this.canonical ??= entry.previous;
    this.pending.push(entry);
    if (this.canonical) this.operations.publish(this.projectPending());
    this.tail = this.tail.then(() => this.commit(entry), () => this.commit(entry));
  }

  private async commit(entry: PendingWrite): Promise<void> {
    try {
      const response = await this.operations.write(entry.patch);
      this.pending = this.pending.filter(candidate => candidate !== entry);
      const projected = this.projectCanonical(response);
      this.operations.publish(projected);
      this.operations.onSuccess?.(entry.previous, response, entry.patch);
      entry.resolve?.(projected);
    } catch (reason) {
      this.pending = this.pending.filter(candidate => candidate !== entry);
      try {
        this.operations.publish(this.projectCanonical(await this.operations.refresh()));
      } catch {
        if (this.canonical) this.operations.publish(this.projectPending());
      }
      try {
        this.operations.onError?.(reason);
      } catch { /* A presentation callback must not break the write queue. */ }
      entry.reject?.(reason);
    }
  }

  private projectPending(): WorkspacePreferencesDto {
    return this.pending.reduce((current, pending) => ({ ...current, ...pending.patch }), this.canonical!);
  }
}
