// @vitest-environment node

import type { ProjectBrowserSessionDto } from "@ponderosa/core";
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
    session?: ProjectBrowserSessionDto;
  }) => session
    ? <button aria-label="Mock browser viewport" aria-disabled={!operatorControl} onClick={() => sendInput({ kind: "click", x: 640, y: 360 })}>viewport</button>
    : <>{empty}</>,
}));

import { ProjectBrowserDialog } from "../src/components/ProjectBrowserDialog";

const now = "2026-07-23T12:00:00.000Z";
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

  it.each([
    ["HTTP failure", new ApiRequestError(500, "Project browser service unavailable")],
    ["network failure", new Error("Project browser network failed")],
  ])("gives a Project browser refetch %s precedence over a retained ready session", async (_label, queryError) => {
    vi.spyOn(api, "getProjectBrowser")
      .mockResolvedValueOnce(projectSession)
      .mockRejectedValue(queryError);
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
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("Mock browser viewport"));

    await act(async () => {
      await client.refetchQueries({ queryKey: ["project-browser", "project-1"] });
    });
    await vi.waitFor(() => {
      const output = JSON.stringify(view.toJSON());
      expect(output).toContain("Interactive browser could not be loaded");
      expect(output).toContain("Retry");
      expect(output).not.toContain("Mock browser viewport");
      expect(output).not.toContain("No Interactive Browser is open");
      expect(output).not.toContain("Open Browser");
    });
    view.unmount();
    client.clear();
  });

  it("gives a Project browser refetch 404 precedence over a retained ready session", async () => {
    vi.spyOn(api, "getProjectBrowser")
      .mockResolvedValueOnce(projectSession)
      .mockRejectedValue(new ApiRequestError(404, "Project browser not found"));
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
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("Mock browser viewport"));

    await act(async () => {
      await client.refetchQueries({ queryKey: ["project-browser", "project-1"] });
    });
    await vi.waitFor(() => {
      const output = JSON.stringify(view.toJSON());
      expect(output).toContain("No Interactive Browser is open");
      expect(output).toContain("Open Browser");
      expect(output).not.toContain("Mock browser viewport");
      expect(output).not.toContain("Interactive browser could not be loaded");
    });
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
