import { createContext, useContext } from "react";

export interface ProjectBrowserRequest {
  url?: string;
  requestId: number;
}

export interface ProjectBrowserContextValue {
  projectId?: string;
  open(url?: string): void;
}

export const ProjectBrowserContext = createContext<ProjectBrowserContextValue>({ open() {} });

export function useProjectBrowser(): ProjectBrowserContextValue {
  return useContext(ProjectBrowserContext);
}
