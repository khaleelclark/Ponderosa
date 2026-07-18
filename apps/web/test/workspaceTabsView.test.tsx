import type { AgentDto, ConversationDto, ProjectDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "../src/components/WorkspaceTabs";
import { openWorkspaceTab } from "../src/workspaceTabs";

const projects: ProjectDto[] = [
  { id: "alpha", label: "Website", hostPath: "/work/website", defaultEngine: "codex", createdAt: "2026-07-17T00:00:00.000Z" },
  { id: "beta", label: "Research", hostPath: "/work/research", defaultEngine: "codex", createdAt: "2026-07-17T00:00:00.000Z" },
];
const conversations: ConversationDto[] = [
  { id: "release", projectId: "alpha", title: "Release planning", createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z", archived: false },
];
const agents: AgentDto[] = [
  { id: "reviewer", projectId: "beta", title: "QA Reviewer", conversationIds: [], activeEngine: "codex", state: {}, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z", archived: false },
];

describe("workspace tab bar", () => {
  it("renders and controls resources from different projects", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["conversations", "alpha"], conversations);
    client.setQueryData(["agents", "alpha"], []);
    client.setQueryData(["conversations", "beta"], []);
    client.setQueryData(["agents", "beta"], agents);
    client.setQueryData(["token-usage", "project", "beta", "30d"], { finalizedRuns: 0, reportedRuns: 0, unreportedRuns: 0 });
    const releaseRoute = { kind: "conversation", projectId: "alpha", conversationId: "release" } as const;
    const reviewerRoute = { kind: "agent", projectId: "beta", agentId: "reviewer" } as const;
    const tabs = openWorkspaceTab(openWorkspaceTab([], releaseRoute, 1), reviewerRoute, 2);
    const navigate = vi.fn();
    const onClose = vi.fn();
    const onCloseAll = vi.fn();
    const view = create(<QueryClientProvider client={client}><WorkspaceTabs
      tabs={tabs}
      projects={projects}
      route={reviewerRoute}
      navigate={navigate}
      onClose={onClose}
      onCloseAll={onCloseAll}
    /></QueryClientProvider>);

    const rendered = JSON.stringify(view.toJSON());
    expect(view.root.findAll((node) => node.props.children === "Home")).toHaveLength(0);
    expect(rendered).toContain("Release planning");
    expect(rendered).toContain("Website");
    expect(rendered).toContain("QA Reviewer");
    expect(rendered).toContain("Research");
    act(() => view.root.findByProps({ "aria-label": "Close QA Reviewer" }).props.onClick());
    expect(onClose).toHaveBeenCalledWith("agent:beta:reviewer");
    const releaseTabContainer = view.root.findByProps({ "data-tab-key": "conversation:alpha:release" });
    expect(releaseTabContainer.props.onContextMenu).toEqual(expect.any(Function));
    expect(releaseTabContainer.props.sx.borderRadius).toBe("12px 12px 0 0");
    expect(releaseTabContainer.props.sx.borderColor).toBe("divider");
    expect(releaseTabContainer.props.sx.borderBottom).toBe(0);
    expect(onCloseAll).not.toHaveBeenCalled();
    const releaseTab = view.root.findByProps({ "aria-label": "Open Release planning in Website" });
    act(() => releaseTab.props.onClick());
    expect(navigate).toHaveBeenCalledWith(releaseRoute);
    view.unmount();
    client.clear();
  });
});
