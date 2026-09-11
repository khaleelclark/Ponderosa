export function sameWorkspaceDirectoryScope(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[],
): boolean {
  if (!previous) return false;
  return previous[0] === current[0] &&
    previous[1] === current[1] &&
    previous[3] === current[3] &&
    previous[4] === current[4] &&
    previous[5] === current[5] &&
    previous[7] === current[7] &&
    previous[8] === current[8] &&
    previous[9] === current[9];
}

export function projectScopedWorkspaceDirectoryItems<
  T extends { project: { id: string } },
>(items: readonly T[], projectId: string | undefined): T[] {
  return projectId
    ? items.filter(item => item.project.id === projectId)
    : [];
}
