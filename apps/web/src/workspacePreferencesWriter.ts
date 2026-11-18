import type { BranchFolderDto, ChatFolderDto, ProjectFolderDto, WorkspacePreferencesDto, UpdateWorkspacePreferencesRequest } from "@ponderosa/core";

type PreferencePatch = Partial<WorkspacePreferencesDto> & Pick<UpdateWorkspacePreferencesRequest, "projectFoldersRevision" | "chatFoldersRevision" | "branchFoldersRevision">;

/** Reuse the same reviewed membership merge without touching Project ownership. */
export function rebaseChatFolderChange(current: ChatFolderDto[], before: ChatFolderDto[], after: ChatFolderDto[]): ChatFolderDto[] {
  const toMembers = (folders: ChatFolderDto[]) => folders.map(({ conversationIds, ...folder }) => ({ ...folder, projectIds: conversationIds }));
  const previous = new Map(before.map(folder => [folder.id, folder]));
  const desired = new Map(after.map(folder => [folder.id, folder]));
  return rebaseFolderChange(toMembers(current), toMembers(before), toMembers(after))
    .map(({ projectIds, ...folder }) => {
      const old = previous.get(folder.id);
      const wanted = desired.get(folder.id);
      // A stale rename, move, or expand must not clear a concurrent star.
      const changedStar = wanted && (!old || Boolean(wanted.starred) !== Boolean(old.starred));
      return {
        ...folder,
        ...(changedStar ? { starred: Boolean(wanted.starred) } : {}),
        conversationIds: projectIds,
      };
    });
}

/** Branch folders reuse the same membership and concurrent-star merge. */
export function rebaseBranchFolderChange(current: BranchFolderDto[], before: BranchFolderDto[], after: BranchFolderDto[]): BranchFolderDto[] {
 const chats=(folders:BranchFolderDto[])=>folders.map(({branchIds,...folder})=>({...folder,conversationIds:branchIds}));
 return rebaseChatFolderChange(chats(current),chats(before),chats(after)).map(({conversationIds,...folder})=>({...folder,branchIds:conversationIds}));
}

/** Reapply changed fields/membership only; untouched concurrent intent survives. */
export function rebaseFolderChange(current: ProjectFolderDto[], before: ProjectFolderDto[], after: ProjectFolderDto[]): ProjectFolderDto[] {
  const previous = new Map(before.map(f => [f.id, f]));
  const desired = new Map(after.map(f => [f.id, f]));
  const destination = (folders: ProjectFolderDto[], id: string) => folders.find(f => f.projectIds.includes(id))?.id;
  const changedMembers = new Set([...before, ...after].flatMap(f => f.projectIds).filter(id => destination(before, id) !== destination(after, id)));
  let result = current.filter(f => !previous.has(f.id) || desired.has(f.id)).map(f => ({ ...f, projectIds: f.projectIds.filter(id => !changedMembers.has(id)) }));
  for (const wanted of after) {
    const old = previous.get(wanted.id);
    let folder = result.find(f => f.id === wanted.id);
    if (!folder && !old) { folder = { ...wanted, projectIds: [] }; result.push(folder); }
    if (!folder) continue; // A concurrent ungroup must not be resurrected by a rename/toggle.
    if (!old || wanted.name !== old.name) folder.name = wanted.name;
    if (!old || wanted.expanded !== old.expanded) folder.expanded = wanted.expanded;
    const added = wanted.projectIds.filter(id => changedMembers.has(id));
    folder.projectIds.push(...added);
    if (!old || JSON.stringify(wanted.projectIds) !== JSON.stringify(old.projectIds)) {
      const retained = new Set(folder.projectIds);
      folder.projectIds = [...wanted.projectIds.filter(id => retained.has(id)), ...folder.projectIds.filter(id => !wanted.projectIds.includes(id))];
    }
  }
  return result.filter(f => f.projectIds.length);
}

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
      let response: WorkspacePreferencesDto | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const patch = this.rebasePatch(entry, this.canonical!);
        try {
          response = await this.operations.write(patch);
          break;
        } catch (error) {
          if ((!entry.patch.projectFolders && !entry.patch.chatFolders && !entry.patch.branchFolders) || attempt === 2 || (error as { status?: number }).status !== 409) throw error;
          this.projectCanonical(await this.operations.refresh());
        }
      }
      if (!response) throw new Error("Folder change could not be saved. Please retry.");
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
    return this.pending.reduce((current, pending) => {
      const { projectFoldersRevision: _revision, chatFoldersRevision: _chatRevision, branchFoldersRevision: _branchRevision, ...patch } = this.rebasePatch(pending, current);
      return { ...current, ...patch };
    }, this.canonical!);
  }

  private rebasePatch(entry: PendingWrite, current: WorkspacePreferencesDto): PreferencePatch {
    return { ...entry.patch,
      ...(entry.patch.branchFolders ? {branchFoldersRevision:current.revision, branchFolders:rebaseBranchFolderChange(current.branchFolders??[],entry.previous?.branchFolders??[],entry.patch.branchFolders)} : {}),
      ...(entry.patch.projectFolders ? { projectFoldersRevision: current.revision,
        projectFolders: rebaseFolderChange(current.projectFolders ?? [], entry.previous?.projectFolders ?? [], entry.patch.projectFolders) } : {}),
      ...(entry.patch.chatFolders ? { chatFoldersRevision: current.revision,
        chatFolders: rebaseChatFolderChange(current.chatFolders ?? [], entry.previous?.chatFolders ?? [], entry.patch.chatFolders) } : {}),
    };
  }
}
