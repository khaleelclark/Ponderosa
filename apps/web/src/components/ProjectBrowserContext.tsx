import { createContext, useContext } from "react";

export interface ProjectBrowserRequest {
  url?: string;
  requestId: number;
}

export interface ProjectBrowserContextValue {
  projectId?: string;
  open(url?: string): void;
  openAgent?(agentId: string, runId: string): void;
}

export function consumeProjectBrowserRequest(
  current: ProjectBrowserRequest | undefined,
  requestId: number,
): ProjectBrowserRequest | undefined {
  return current?.requestId === requestId ? undefined : current;
}

export const ProjectBrowserContext = createContext<ProjectBrowserContextValue>({ open() {} });

export function useProjectBrowser(): ProjectBrowserContextValue {
  return useContext(ProjectBrowserContext);
}
