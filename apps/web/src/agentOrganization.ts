import type {
  AgentOrganizationNodeDto,
  AgentOrganizationPageDto,
} from "@ponderosa/core";

export function isLiveOrganizationNode(
  node: AgentOrganizationNodeDto,
): node is Exclude<AgentOrganizationNodeDto, { relation: { kind: "deleted" } }> {
  return node.relation.kind !== "deleted";
}

export function mergeOrganizationPages(
  pages: readonly AgentOrganizationPageDto[] | undefined,
): AgentOrganizationNodeDto[] {
  if (!pages) return [];
  const byId = new Map<string, AgentOrganizationNodeDto>();
  for (const page of pages) for (const node of page.items) byId.set(node.id, node);
  return [...byId.values()];
}

export function organizationOwnerLabel(
  node: AgentOrganizationNodeDto,
  ownerLoading = false,
): string {
  if (node.relation.kind === "deleted") return `Deleted ${node.relation.deletedAt}`;
  if (node.relation.kind === "independent") return "Reports to you";
  if (node.relation.kind === "orphaned") {
    return `Owner unavailable (${node.relation.managerAgentId})`;
  }
  return ownerLoading ? "Owner loading…" : `Reports to ${node.relation.manager.title}`;
}

export function pruneExpandedAgentIds(
  expanded: ReadonlySet<string>,
  removedAgentIds: readonly string[],
): Set<string> {
  const next = new Set(expanded);
  for (const id of removedAgentIds) next.delete(id);
  return next;
}
