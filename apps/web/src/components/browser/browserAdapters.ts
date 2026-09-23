import type {
  BrowserOperatorInputRequest,
  BrowserSessionDto,
  BrowserUploadReceiptDto,
  ProjectBrowserSessionDto,
  BrowserFrameMetadata,
  BrowserViewportSize,
} from "@ponderosa/core";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";

export type BrowserSession = BrowserSessionDto | ProjectBrowserSessionDto;
export interface BrowserUploadResponse<Session extends BrowserSession> {
  session: Session;
  upload: BrowserUploadReceiptDto;
}
export type UnfencedBrowserInput = BrowserOperatorInputRequest extends infer Input
  ? Input extends BrowserOperatorInputRequest ? Omit<Input, "expectedControlEpoch"> : never
  : never;

export interface BrowserControlTarget {
  nextRun?: boolean;
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
  activatePage(pageId: string, expectedControlEpoch: number): Promise<Session>;
  closePage(pageId: string, expectedControlEpoch: number): Promise<Session>;
  upload(artifactId: string, selector: string | undefined, expectedControlEpoch: number): Promise<BrowserUploadResponse<Session>>;
  cancelFileChooser(expectedControlEpoch: number): Promise<Session>;
  setControl(target: BrowserControlTarget, expectedControlEpoch: number): Promise<Session>;
  sendInput(input: UnfencedBrowserInput, expectedControlEpoch: number): Promise<Session>;
  getFrame(pageId?: string): Promise<{ blob: Blob; revision: number; metadata?: BrowserFrameMetadata }>;
  newPage?(expectedControlEpoch: number): Promise<Session>;
  resizeViewport?(pageId: string, size: BrowserViewportSize, expectedControlEpoch: number): Promise<unknown>;
}

export function projectBrowserAdapter(projectId: string): BrowserEndpointAdapter<ProjectBrowserSessionDto> {
  return {
    queryKey: queryKeys.projectBrowser.project(projectId),
    get: () => api.getProjectBrowser(projectId),
    open: (url) => api.openProjectBrowser(projectId, url),
    navigate: (url) => api.navigateProjectBrowser(projectId, url),
    reconnect: () => api.reconnectProjectBrowser(projectId),
    close: () => api.closeProjectBrowser(projectId),
    activatePage: (pageId, expectedControlEpoch) => api.activateProjectBrowserPage(projectId, pageId, expectedControlEpoch),
    closePage: (pageId, expectedControlEpoch) => api.closeProjectBrowserPage(projectId, pageId, expectedControlEpoch),
    upload: (artifactId, selector, expectedControlEpoch) => api.uploadProjectBrowserArtifact(projectId, artifactId, selector, expectedControlEpoch),
    cancelFileChooser: (expectedControlEpoch) => api.cancelProjectBrowserFileChooser(projectId, expectedControlEpoch),
    setControl: ({ owner, agentId, nextRun }, expectedControlEpoch) => api.setProjectBrowserControl(projectId, {
      nextRun,
      owner,
      expectedControlEpoch,
      ...(agentId ? { agentId } : {}),
    }),
    sendInput: (input, expectedControlEpoch) => api.sendProjectBrowserInput(projectId, {
      ...input,
      expectedControlEpoch,
    } as BrowserOperatorInputRequest),
    getFrame: pageId => api.getProjectBrowserFrame(projectId, pageId),
    newPage: epoch => api.newBrowserPage(projectId, epoch) as Promise<ProjectBrowserSessionDto>,
    resizeViewport: (pageId, size, epoch) => api.resizeBrowserViewport(projectId, pageId, size, epoch),
  };
}

export function agentBrowserAdapter(
  projectId: string,
  agentId: string,
  runId: string,
): BrowserEndpointAdapter<BrowserSessionDto> {
  return {
    queryKey: queryKeys.agentBrowsers.session(projectId, agentId, runId),
    get: () => api.getBrowserSession(projectId, agentId, runId),
    open: () => api.openBrowserSession(projectId, agentId, runId),
    navigate: url => api.navigateAgentBrowser(projectId, agentId, runId, url),
    reconnect: () => api.reconnectBrowserSession(projectId, agentId, runId),
    close: () => api.closeBrowserSession(projectId, agentId, runId),
    activatePage: (pageId, expectedControlEpoch) => api.activateBrowserPage(projectId, agentId, runId, pageId, expectedControlEpoch),
    closePage: (pageId, expectedControlEpoch) => api.closeBrowserPage(projectId, agentId, runId, pageId, expectedControlEpoch),
    upload: (artifactId, selector, expectedControlEpoch) => api.uploadBrowserArtifact(projectId, agentId, runId, artifactId, selector, expectedControlEpoch),
    cancelFileChooser: (expectedControlEpoch) => api.cancelBrowserFileChooser(projectId, agentId, runId, expectedControlEpoch),
    setControl: ({ owner }, expectedControlEpoch) => api.setBrowserControl(
      projectId,
      agentId,
      runId,
      { owner, expectedControlEpoch },
    ),
    sendInput: (input, expectedControlEpoch) => api.sendBrowserInput(
      projectId,
      agentId,
      runId,
      { ...input, expectedControlEpoch } as BrowserOperatorInputRequest,
    ),
    getFrame: pageId => api.getBrowserFrame(projectId, agentId, runId, pageId),
    newPage: epoch => api.newBrowserPage(projectId, epoch, agentId, runId) as Promise<BrowserSessionDto>,
    resizeViewport: (pageId, size, epoch) => api.resizeBrowserViewport(projectId, pageId, size, epoch, agentId, runId),
  };
}
