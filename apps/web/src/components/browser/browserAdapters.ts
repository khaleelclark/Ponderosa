import type {
  BrowserOperatorInputRequest,
  BrowserSessionDto,
  ProjectBrowserSessionDto,
} from "@ponderosa/core";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";

export type BrowserSession = BrowserSessionDto | ProjectBrowserSessionDto;
export type UnfencedBrowserInput = BrowserOperatorInputRequest extends infer Input
  ? Input extends BrowserOperatorInputRequest ? Omit<Input, "expectedControlEpoch"> : never
  : never;

export interface BrowserControlTarget {
  owner: "agent" | "operator";
  agentId?: string;
}

/** The browser UI depends on this narrow contract, never on URL construction. */
export interface BrowserEndpointAdapter<Session extends BrowserSession> {
  queryKey: readonly unknown[];
  get(): Promise<Session>;
  open?(url?: string): Promise<Session>;
  navigate?(url: string): Promise<Session>;
  reconnect(): Promise<Session>;
  close(): Promise<Session>;
  setControl(target: BrowserControlTarget, expectedControlEpoch: number): Promise<Session>;
  sendInput(input: UnfencedBrowserInput, expectedControlEpoch: number): Promise<Session>;
  getFrame(): Promise<{ blob: Blob; revision: number }>;
}

export function projectBrowserAdapter(projectId: string): BrowserEndpointAdapter<ProjectBrowserSessionDto> {
  return {
    queryKey: queryKeys.projectBrowser.project(projectId),
    get: () => api.getProjectBrowser(projectId),
    open: (url) => api.openProjectBrowser(projectId, url),
    navigate: (url) => api.navigateProjectBrowser(projectId, url),
    reconnect: () => api.reconnectProjectBrowser(projectId),
    close: () => api.closeProjectBrowser(projectId),
    setControl: ({ owner, agentId }, expectedControlEpoch) => api.setProjectBrowserControl(projectId, {
      owner,
      expectedControlEpoch,
      ...(agentId ? { agentId } : {}),
    }),
    sendInput: (input, expectedControlEpoch) => api.sendProjectBrowserInput(projectId, {
      ...input,
      expectedControlEpoch,
    } as BrowserOperatorInputRequest),
    getFrame: () => api.getProjectBrowserFrame(projectId),
  };
}
