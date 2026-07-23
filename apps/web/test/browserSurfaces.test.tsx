import type { BrowserSessionDto, ProjectBrowserSessionDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ApiRequestError } from "../src/api/types";

vi.mock("../src/components/browser/BrowserViewport", () => ({
  BrowserViewport: ({
    empty, operatorControl, sendInput, session,
  }: {
    empty?: ReactNode;
    operatorControl: boolean;
    sendInput(value: unknown): void;
    session?: BrowserSessionDto | ProjectBrowserSessionDto;
  }) => session
    ? <button aria-label="Mock browser viewport" aria-disabled={!operatorControl} onClick={() => sendInput({ kind: "click", x: 640, y: 360 })}>viewport</button>
    : <>{empty}</>,
}));

import { BrowserPanel } from "../src/components/BrowserPanel";
import { ProjectBrowserDialog } from "../src/components/ProjectBrowserDialog";

const now = "2026-07-23T12:00:00.000Z";
const runSession: BrowserSessionDto = {
  id: "browser-1",
  projectId: "project-1",
  agentId: "agent-1",
  runId: "run-1",
  status: "ready",
  controlOwner: "operator",
  controlEpoch: 9,
  url: "https://example.com",
  frameRevision: 1,
  openedAt: now,
  updatedAt: now,
};
const projectSession: ProjectBrowserSessionDto = {
  id: "project-browser-1",
  projectId: "project-1",
  status: "ready",
  controlOwner: "operator",
  controlEpoch: 12,
  url: "https://example.com",
  frameRevision: 1,
  openedAt: now,
  updatedAt: now,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared browser surfaces", () => {
  it("shows initial loading distinctly before a terminal missing or closed session", async () => {
    let rejectSession!: (error: unknown) => void;
    vi.spyOn(api, "getBrowserSession").mockImplementation(() => new Promise((_resolve, reject) => {
      rejectSession = reject;
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><BrowserPanel projectId="project-1" agentId="agent-1" runId="run-pending" standalone /></QueryClientProvider>);
    });

    expect(view.root.findByProps({ role: "status" }).props["aria-live"]).toBe("polite");
    expect(JSON.stringify(view.toJSON())).toContain("Loading interactive browser");
    expect(JSON.stringify(view.toJSON())).not.toContain("no longer active");

    await act(async () => {
      rejectSession(new ApiRequestError(404, "Browser session not found"));
    });
    await vi.waitFor(() => {
      expect(JSON.stringify(view.toJSON())).not.toContain("Loading interactive browser");
      expect(JSON.stringify(view.toJSON())).toContain("no longer active");
    });
    view.unmount();
    client.clear();

    vi.restoreAllMocks();
    vi.spyOn(api, "getBrowserSession").mockResolvedValue({ ...runSession, runId: "run-closed", status: "closed" });
    const closedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let closedView!: ReturnType<typeof create>;
    await act(async () => {
      closedView = create(<QueryClientProvider client={closedClient}><BrowserPanel projectId="project-1" agentId="agent-1" runId="run-closed" standalone /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(JSON.stringify(closedView.toJSON())).toContain("no longer active"));
    expect(JSON.stringify(closedView.toJSON())).not.toContain("Loading interactive browser");
    closedView.unmount();
    closedClient.clear();
  });

  it.each([
    ["HTTP failure", new ApiRequestError(500, "Browser service unavailable")],
    ["network failure", new Error("Network connection failed")],
  ])("keeps a failed Run browser query recoverable after an %s", async (_label, queryError) => {
    const getSession = vi.spyOn(api, "getBrowserSession").mockRejectedValue(queryError);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><BrowserPanel projectId="project-1" agentId="agent-1" runId="run-error" standalone /></QueryClientProvider>);
    });

    await vi.waitFor(() => {
      const output = JSON.stringify(view.toJSON());
      expect(output).toContain("Interactive browser could not be loaded");
      expect(output).not.toContain("no longer active");
    });
    await act(async () => view.root.findByProps({ children: "Retry" }).props.onClick());
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    view.unmount();
    client.clear();
  });

  it.each([
    ["HTTP failure", new ApiRequestError(500, "Project browser service unavailable")],
    ["network failure", new Error("Project browser network failed")],
  ])("keeps a failed Project browser query recoverable after an %s", async (_label, queryError) => {
    const getBrowser = vi.spyOn(api, "getProjectBrowser").mockRejectedValue(queryError);
    vi.spyOn(api, "listAgents").mockResolvedValue([]);
    vi.spyOn(api, "getAgentHealth").mockResolvedValue({
      projectId: "project-1",
      generatedAt: now,
      agents: [],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ProjectBrowserDialog
        projectId="project-1"
        open
        embedded
        onClose={vi.fn()}
      /></QueryClientProvider>);
    });

    await vi.waitFor(() => {
      const output = JSON.stringify(view.toJSON());
      expect(output).toContain("Interactive browser could not be loaded");
      expect(output).not.toContain("No Interactive Browser is open");
      expect(output).not.toContain("Open Browser");
    });
    await act(async () => view.root.findByProps({ children: "Retry" }).props.onClick());
    await vi.waitFor(() => expect(getBrowser).toHaveBeenCalledTimes(2));
    view.unmount();
    client.clear();
  });

  it("renders the compact Run session and routes Open Tab interaction", async () => {
    vi.spyOn(api, "getBrowserSession").mockResolvedValue(runSession);
    const openTab = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["browser-session", "project-1", "agent-1", "run-1"], runSession);
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><BrowserPanel projectId="project-1" agentId="agent-1" runId="run-1" onOpenInTab={openTab} /></QueryClientProvider>);
    });
    expect(JSON.stringify(view.toJSON())).toContain("Interactive browser in use");
    act(() => view.root.findByProps({ children: "Open Tab" }).props.onClick());
    expect(openTab).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
  });

  it("fences Run viewport input and ownership transfer with the observed epoch", async () => {
    vi.spyOn(api, "getBrowserSession").mockResolvedValue(runSession);
    const input = vi.spyOn(api, "sendBrowserInput").mockResolvedValue(runSession);
    const control = vi.spyOn(api, "setBrowserControl").mockResolvedValue({ ...runSession, controlOwner: "agent", controlEpoch: 10 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["browser-session", "project-1", "agent-1", "run-1"], runSession);
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><BrowserPanel projectId="project-1" agentId="agent-1" runId="run-1" standalone /></QueryClientProvider>);
    });
    await act(async () => view.root.findByProps({ "aria-label": "Mock browser viewport" }).props.onClick());
    expect(input).toHaveBeenCalledWith("project-1", "agent-1", "run-1", { kind: "click", x: 640, y: 360, expectedControlEpoch: 9 });
    await act(async () => view.root.findByProps({ children: "Return Control to Agent" }).props.onClick());
    expect(control).toHaveBeenCalledWith("project-1", "agent-1", "run-1", { owner: "agent", expectedControlEpoch: 9 });
    view.unmount();
    client.clear();
  });

  it("offers only running Agents for Project control and consumes an open request once", async () => {
    vi.spyOn(api, "getProjectBrowser").mockResolvedValue(projectSession);
    const openBrowser = vi.spyOn(api, "openProjectBrowser").mockResolvedValue(projectSession);
    const control = vi.spyOn(api, "setProjectBrowserControl").mockResolvedValue({ ...projectSession, controlOwner: "agent", controllerAgentId: "agent-running", controlEpoch: 13 });
    vi.spyOn(api, "listAgents").mockResolvedValue([
      { id: "agent-running", projectId: "project-1", title: "Runner", conversationIds: [], activeEngine: "codex", state: {}, createdAt: now, updatedAt: now, archived: false },
      { id: "agent-idle", projectId: "project-1", title: "Idle", conversationIds: [], activeEngine: "codex", state: {}, createdAt: now, updatedAt: now, archived: false },
    ]);
    vi.spyOn(api, "getAgentHealth").mockResolvedValue({
      projectId: "project-1",
      generatedAt: now,
      agents: [{ agentId: "agent-running", status: "running", pendingQueueDepth: 0, unreadCount: 0 }],
    });
    const handled = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["project-browser", "project-1"], projectSession);
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ProjectBrowserDialog
        projectId="project-1"
        open
        embedded
        request={{ requestId: 4, url: "https://example.com/review" }}
        onRequestHandled={handled}
        onClose={vi.fn()}
      /></QueryClientProvider>);
    });
    const controlButton = () => view.root.findAll((node) =>
      Array.isArray(node.props.children) && node.props.children.flat().join("") === "Give Runner Control",
    )[0];
    await vi.waitFor(() => expect(controlButton()).toBeTruthy());
    expect(JSON.stringify(view.toJSON())).not.toContain("Give Idle Control");
    expect(handled).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    await act(async () => controlButton()!.props.onClick());
    expect(control).toHaveBeenCalledWith("project-1", { owner: "agent", agentId: "agent-running", expectedControlEpoch: 12 });
    view.update(<QueryClientProvider client={client}><ProjectBrowserDialog
      projectId="project-1"
      open
      embedded
      request={{ requestId: 4, url: "https://example.com/review" }}
      onRequestHandled={handled}
      onClose={vi.fn()}
    /></QueryClientProvider>);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    view.unmount();
    client.clear();
  });
});
