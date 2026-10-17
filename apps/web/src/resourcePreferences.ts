import type {
  ChatFolderDto,
  ProjectSort,
  WorkspaceConversationDirectoryItemDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";

export type WorkspaceResourceKind = "project" | "conversation" | "agent";
export type WorkspaceResourceSortKind = "home" | "chat" | "agent";

export function resourcePreferenceKey(kind: WorkspaceResourceKind, id: string): string {
  return `${kind}:${id}`;
}

export function starredWorkspaceResources(preferences: WorkspacePreferencesDto): Set<string> {
  return new Set([
    ...(preferences.starredResourceIds ?? []),
    ...preferences.starredProjectIds.map((id) => resourcePreferenceKey("project", id)),
  ]);
}

export function workspaceResourceStarsChanged(
  previous: WorkspacePreferencesDto | undefined,
  next: WorkspacePreferencesDto,
): boolean {
  if (!previous) return true;
  const previousStars = starredWorkspaceResources(previous);
  const nextStars = starredWorkspaceResources(next);
  return previousStars.size !== nextStars.size
    || [...previousStars].some(key => !nextStars.has(key));
}

function sameSequence(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  return leftItems.length === rightItems.length &&
    leftItems.every((item, index) => item === rightItems[index]);
}

/** Directory projections affected by one canonical preference change. */
export function changedWorkspaceDirectoryKinds(
  previous: WorkspacePreferencesDto | undefined,
  next: WorkspacePreferencesDto,
): WorkspaceResourceKind[] {
  if (!previous) return ["project", "conversation", "agent"];
  const changed = new Set<WorkspaceResourceKind>();
  if (
    previous.projectSort !== next.projectSort ||
    !sameSequence(previous.projectOrder, next.projectOrder)
  ) changed.add("project");
  if (
    previous.chatSort !== next.chatSort ||
    !sameSequence(previous.chatOrder, next.chatOrder)
  ) changed.add("conversation");
  if (
    previous.agentSort !== next.agentSort ||
    !sameSequence(previous.agentOrder, next.agentOrder)
  ) changed.add("agent");

  const previousStars = starredWorkspaceResources(previous);
  const nextStars = starredWorkspaceResources(next);
  for (const key of new Set([...previousStars, ...nextStars])) {
    if (previousStars.has(key) === nextStars.has(key)) continue;
    const kind = key.slice(0, key.indexOf(":"));
    if (
      kind === "project" || kind === "conversation" ||
      kind === "agent"
    ) changed.add(kind);
  }
  return [...changed];
}

export function toggleWorkspaceResourceStar(
  preferences: WorkspacePreferencesDto,
  kind: WorkspaceResourceKind,
  id: string,
): Pick<WorkspacePreferencesDto, "starredResourceIds" | "starredProjectIds"> {
  const key = resourcePreferenceKey(kind, id);
  const starred = starredWorkspaceResources(preferences);
  if (starred.has(key)) starred.delete(key);
  else starred.add(key);
  return {
    starredResourceIds: [...starred],
    starredProjectIds: [...starred]
      .filter((value) => value.startsWith("project:"))
      .map((value) => value.slice("project:".length)),
  };
}

export function workspaceResourceSort(preferences: WorkspacePreferencesDto, kind: WorkspaceResourceSortKind): ProjectSort {
  if (kind === "home") return preferences.homeSort ?? "last_used";
  if (kind === "chat") return preferences.chatSort ?? "last_used";
  return preferences.agentSort ?? "last_used";
}

export function workspaceResourceSortPatch(kind: WorkspaceResourceSortKind, sort: ProjectSort): Partial<WorkspacePreferencesDto> {
  if (kind === "home") return { homeSort: sort };
  if (kind === "chat") return { chatSort: sort };
  return { agentSort: sort };
}

export function reorderStableIds(
  current: readonly string[] | undefined,
  visibleIds: readonly string[],
  sourceId: string,
  targetId: string,
  position: "before" | "after" = "before",
): string[] {
  const visible = new Set(visibleIds);
  const fullOrder = [...new Set([...(current ?? []), ...visibleIds])];
  const visibleOrder = fullOrder.filter((id) => visible.has(id));
  const source = visibleOrder.indexOf(sourceId);
  const target = visibleOrder.indexOf(targetId);
  if (source < 0 || target < 0 || source === target) return fullOrder;
  visibleOrder.splice(source, 1);
  const remainingTarget = visibleOrder.indexOf(targetId);
  visibleOrder.splice(
    remainingTarget + (position === "after" ? 1 : 0),
    0,
    sourceId,
  );
  let visibleIndex = 0;
  return fullOrder.map((id) =>
    visible.has(id) ? visibleOrder[visibleIndex++]! : id,
  );
}

/** Start custom ordering from what the operator currently sees, retaining off-page IDs. */
export function customOrderSeed(
  current: readonly string[] | undefined,
  visible: readonly string[],
): string[] {
  const visibleIds = new Set(visible);
  return [...new Set([...visible, ...(current ?? []).filter(id => !visibleIds.has(id))])];
}

export function sortWorkspaceResources<T>(
  items: T[],
  sort: ProjectSort,
  order: readonly string[] | undefined,
  identity: (item: T) => string,
  title: (item: T) => string,
  updatedAt: (item: T) => string,
): T[] {
  if (sort === "alphabetical") return [...items].sort((a, b) => title(a).localeCompare(title(b)) || identity(a).localeCompare(identity(b)));
  if (sort === "last_used") return [...items].sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)) || identity(a).localeCompare(identity(b)));
  const rank = new Map((order ?? []).map((id, index) => [id, index] as const));
  return [...items].sort((a, b) => {
    const left = rank.get(identity(a));
    const right = rank.get(identity(b));
    if (left === undefined && right === undefined) return title(a).localeCompare(title(b)) || identity(a).localeCompare(identity(b));
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
}

/** Folder membership order is the custom order; other modes follow Chat activity or title. */
export function sortChatFolderMembers(
  folder: ChatFolderDto,
  items: readonly WorkspaceConversationDirectoryItemDto[],
  sort: ProjectSort,
): WorkspaceConversationDirectoryItemDto[] {
  const members = new Map(items.map(item => [item.conversation.id, item]));
  if (sort === "custom") return folder.conversationIds.flatMap(id => members.get(id) ?? []);
  return sortWorkspaceResources(
    items.filter(item => folder.conversationIds.includes(item.conversation.id)),
    sort,
    undefined,
    item => item.conversation.id,
    item => item.conversation.title,
    item => item.conversation.updatedAt,
  );
}

export function sortChatFolders(
  folders: readonly ChatFolderDto[],
  items: readonly WorkspaceConversationDirectoryItemDto[],
  sort: ProjectSort,
): ChatFolderDto[] {
  if (sort === "custom") return [...folders];
  const updatedAt = new Map(items.map(item => [item.conversation.id, item.conversation.updatedAt]));
  return sortWorkspaceResources(
    [...folders],
    sort,
    undefined,
    folder => folder.id,
    folder => folder.name,
    folder => folder.conversationIds.reduce((latest, id) => {
      const value = updatedAt.get(id) ?? "";
      return value > latest ? value : latest;
    }, ""),
  );
}
