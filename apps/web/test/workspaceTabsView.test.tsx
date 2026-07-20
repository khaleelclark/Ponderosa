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
    const tabs = openWorkspaceTab(openWorkspaceTab([], releaseRoute, 1, "release-tab"), reviewerRoute, 2, "reviewer-tab");
    const onActivate = vi.fn();
    const onCreate = vi.fn();
    const onClose = vi.fn();
    const onCloseOthers = vi.fn();
    const onRename = vi.fn();
    const onReorder = vi.fn();
    const view = create(<QueryClientProvider client={client}><WorkspaceTabs
      tabs={tabs}
      projects={projects}
      activeKey="reviewer-tab"
      onActivate={onActivate}
      onCreate={onCreate}
      onClose={onClose}
      onCloseOthers={onCloseOthers}
      onRename={onRename}
      onReorder={onReorder}
    /></QueryClientProvider>);

    const rendered = JSON.stringify(view.toJSON());
    expect(view.root.findAll((node) => node.props.children === "Home")).toHaveLength(0);
    expect(rendered).toContain("Release planning");
    expect(rendered).toContain("Website");
    expect(rendered).toContain("QA Reviewer");
    expect(rendered).toContain("Research");
    act(() => view.root.findByProps({ "aria-label": "Close QA Reviewer" }).props.onClick({ stopPropagation: vi.fn() }));
    expect(onClose).toHaveBeenCalledWith("reviewer-tab");
    const releaseTabContainer = view.root.findByProps({ "data-tab-key": "release-tab" });
    expect(releaseTabContainer.props.onContextMenu).toEqual(expect.any(Function));
    expect(releaseTabContainer.props.sx.borderRadius).toBe(2);
    expect(releaseTabContainer.props.sx.minWidth).toBe(38);
    expect(releaseTabContainer.props.sx.flex).toBe("1 1 200px");
    const tabStrip = view.root.findByProps({ className: "workspace-tab-strip" });
    expect(tabStrip.props.sx.overflowX).toBe("auto");
    expect(tabStrip.props.sx.scrollbarWidth).toBe("none");
    expect(onCloseOthers).not.toHaveBeenCalled();
    const releaseTab = view.root.findByProps({ "aria-label": "Open Release planning in Website" });
    act(() => releaseTab.props.onClick());
    expect(onActivate).toHaveBeenCalledWith("release-tab");
    act(() => view.root.findByProps({ "aria-label": "New tab" }).props.onClick());
    expect(onCreate).toHaveBeenCalledOnce();

    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => "release-tab"),
    };
    act(() => releaseTabContainer.props.onDragStart({ dataTransfer }));
    const reviewerTabContainer = view.root.findByProps({ "data-tab-key": "reviewer-tab" });
    expect(reviewerTabContainer.props.draggable).toBe(true);
    act(() => reviewerTabContainer.props.onDragOver({ preventDefault: vi.fn(), dataTransfer }));
    act(() => view.root.findByProps({ "data-tab-key": "reviewer-tab" }).props.onDrop({ preventDefault: vi.fn(), dataTransfer }));
    expect(onReorder).toHaveBeenCalledWith("release-tab", "reviewer-tab");
    view.unmount();
    client.clear();
  });
});
