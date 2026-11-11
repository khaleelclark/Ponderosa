import type { ProjectDto } from "@ponderosa/core";

export interface UnreadNotificationProjection {
  importantCount: number;
  ordinaryCount: number;
  totalCount: number;
  /** Ordinary unread activity, excluded from notification badges and alert totals. */
  quietUnreadCount?: number;
}

export function projectDisambiguator(
  project: Pick<ProjectDto, "id" | "label" | "hostPath">,
  projects: ProjectDto[],
): string {
  const duplicateLabel = projects.some((candidate) => candidate.id !== project.id && candidate.label.localeCompare(project.label, undefined, { sensitivity: "base" }) === 0);
  return duplicateLabel ? `${project.label} · ${project.hostPath}` : project.label;
}
