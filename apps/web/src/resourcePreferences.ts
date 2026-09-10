import type {
  ProjectSort,
  WorkspaceDirectoryKind,
  WorkspacePreferencesDto,
} from "@ponderosa/core";

export type WorkspaceResourceKind = "project" | "conversation" | "agent" | "trigger";
export type WorkspaceResourceSortKind = "home" | "chat" | "agent" | "trigger";

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
): WorkspaceDirectoryKind[] {
  if (!previous) return ["project", "conversation", "agent", "trigger"];
  const changed = new Set<WorkspaceDirectoryKind>();
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
  if (
    previous.triggerSort !== next.triggerSort ||
    !sameSequence(previous.triggerOrder, next.triggerOrder)
  ) changed.add("trigger");

  const previousStars = starredWorkspaceResources(previous);
  const nextStars = starredWorkspaceResources(next);
  for (const key of new Set([...previousStars, ...nextStars])) {
    if (previousStars.has(key) === nextStars.has(key)) continue;
    const kind = key.slice(0, key.indexOf(":"));
    if (
      kind === "project" || kind === "conversation" ||
      kind === "agent" || kind === "trigger"
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
  if (kind === "agent") return preferences.agentSort ?? "last_used";
  return preferences.triggerSort ?? "last_used";
}

export function workspaceResourceSortPatch(kind: WorkspaceResourceSortKind, sort: ProjectSort): Partial<WorkspacePreferencesDto> {
  if (kind === "home") return { homeSort: sort };
  if (kind === "chat") return { chatSort: sort };
  if (kind === "agent") return { agentSort: sort };
  return { triggerSort: sort };
}

export function projectOrderPreferenceKey(
  preferences: Pick<WorkspacePreferencesDto, "projectSort" | "projectOrder">,
): string {
  return JSON.stringify([preferences.projectSort, preferences.projectOrder]);
}

export function synchronizeProjectRailOrder(
  current: readonly string[],
  available: readonly string[],
  canonicalOrderChanged: boolean,
): string[] {
  if (canonicalOrderChanged) return [...available];
  const availableIds = new Set(available);
  const stable = current.filter(projectId => availableIds.has(projectId));
  for (const projectId of available) {
    if (!stable.includes(projectId)) stable.push(projectId);
  }
  return stable;
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
