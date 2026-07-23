import type { ProjectDto } from "@ponderosa/core";
import { useQueries } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

export function projectConversationQueries(projects: readonly ProjectDto[]) {
  return projects.map((project) => ({
    queryKey: queryKeys.conversations.project(project.id),
    queryFn: () => api.listConversations(project.id),
    staleTime: 10_000,
  }));
}

export function projectAgentQueries(projects: readonly ProjectDto[]) {
  return projects.map((project) => ({
    queryKey: queryKeys.agents.project(project.id),
    queryFn: () => api.listAgents(project.id),
    staleTime: 5_000,
  }));
}

export function projectAgentHealthQueries(projects: readonly ProjectDto[]) {
  return projects.map((project) => ({
    queryKey: queryKeys.agents.health(project.id),
    queryFn: () => api.getAgentHealth(project.id),
    staleTime: 5_000,
  }));
}

export function useProjectConversations(projects: readonly ProjectDto[]) {
  return useQueries({ queries: projectConversationQueries(projects) });
}

export function useProjectAgents(projects: readonly ProjectDto[]) {
  return useQueries({ queries: projectAgentQueries(projects) });
}

export function useProjectAgentHealth(projects: readonly ProjectDto[]) {
  return useQueries({ queries: projectAgentHealthQueries(projects) });
}
