import type { AgentDto, ConversationDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "../src/components/WorkspaceTabs";
import { openWorkspaceTab } from "../src/workspaceTabs";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Menu: forwardRef<HTMLDivElement, { children?: ReactNode }>(({ children }, ref) =>
      createElement("div", { ref, role: "menu" }, children)),
  };
});

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
const preferences = {
  profile: { displayName: "Patrick", handle: "patrick", avatarId: "default-user" },
} as WorkspacePreferencesDto;

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
      preferences={preferences}
      activeKey="reviewer-tab"
      onActivate={onActivate}
      onCreate={onCreate}
      onSearch={vi.fn()}
      onOpenInbox={vi.fn()}
      onOpenProfile={vi.fn()}
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
    expect(releaseTabContainer.props.sx.minWidth).toEqual({ xs: 132, md: 140 });
    expect(releaseTabContainer.props.sx.flex).toBe("0 1 220px");
    const tabStrip = view.root.findByProps({ className: "workspace-tab-strip" });
    expect(tabStrip.props.sx.overflowX).toBe("auto");
    expect(tabStrip.props.sx.scrollbarWidth).toBe("none");
    expect(onCloseOthers).not.toHaveBeenCalled();
    const releaseTab = view.root.findByProps({ "aria-label": "Open Release planning in Website" });
    act(() => releaseTab.props.onClick());
    expect(onActivate).toHaveBeenCalledWith("release-tab");
    act(() => view.root.findByProps({ "aria-label": "New tab" }).props.onClick());
    expect(onCreate).toHaveBeenCalledOnce();
    expect(view.root.findByProps({ "aria-label": "Open operator profile" })).toBeTruthy();

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

  it("omits the close icon when only one tab remains", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const tabs = openWorkspaceTab([], { kind: "home" }, 1, "home-tab");
    const view = create(<QueryClientProvider client={client}><WorkspaceTabs
      tabs={tabs}
      projects={[]}
      preferences={preferences}
      activeKey="home-tab"
      onActivate={vi.fn()}
      onCreate={vi.fn()}
      onSearch={vi.fn()}
      onOpenInbox={vi.fn()}
      onOpenProfile={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onRename={vi.fn()}
      onReorder={vi.fn()}
    /></QueryClientProvider>);

    expect(view.root.findAll((node) => node.props["aria-label"] === "Close Home")).toHaveLength(0);
    expect(view.root.findByProps({ "aria-label": "Open Home in Ponderosa" })).toBeTruthy();
    view.unmount();
    client.clear();
  });

  it("visibly presents an inactive close control for native and MUI focus-visible states", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const tabs = openWorkspaceTab(
      openWorkspaceTab([], { kind: "projects" }, 1, "inactive-tab"),
      { kind: "allChat" }, 2, "active-tab",
    );
    const view = create(<QueryClientProvider client={client}><WorkspaceTabs
      tabs={tabs}
      projects={[]}
      preferences={preferences}
      activeKey="active-tab"
      onActivate={vi.fn()}
      onCreate={vi.fn()}
      onSearch={vi.fn()}
      onOpenInbox={vi.fn()}
      onOpenProfile={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onRename={vi.fn()}
      onReorder={vi.fn()}
    /></QueryClientProvider>);

    const inactiveClose = view.root.findByProps({ "aria-label": "Close Projects" });
    expect(inactiveClose.props.disabled).toBeUndefined();
    expect(inactiveClose.props.sx.opacity).toEqual({ xs: 0.45, md: 0 });
    expect(inactiveClose.props.sx["&:focus-visible, &.Mui-focusVisible"]).toEqual({
      color: "#E6E7DF",
      opacity: 1,
    });
    view.unmount();
    client.clear();
  });

  it("opens keyboard tab actions that move a tab without changing its persisted identity", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const tabs = openWorkspaceTab(
      openWorkspaceTab(openWorkspaceTab([], { kind: "projects" }, 1, "projects"), { kind: "home" }, 2, "chat"),
      { kind: "allAgents" }, 3, "agents",
    );
    const onReorder = vi.fn();
    const view = create(<QueryClientProvider client={client}><WorkspaceTabs
      tabs={tabs}
      projects={[]}
      preferences={preferences}
      activeKey="chat"
      onActivate={vi.fn()}
      onCreate={vi.fn()}
      onSearch={vi.fn()}
      onOpenInbox={vi.fn()}
      onOpenProfile={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onRename={vi.fn()}
      onReorder={onReorder}
    /></QueryClientProvider>);

    const chatTab = view.root.findByProps({ "aria-label": "Open Home in Ponderosa" });
    expect(chatTab.props["aria-keyshortcuts"]).toBe("Shift+F10");
    const menuKey = { key: "ContextMenu", shiftKey: false, preventDefault: vi.fn(), currentTarget: {} };
    act(() => chatTab.props.onKeyDown(menuKey));
    expect(menuKey.preventDefault).toHaveBeenCalledOnce();
    const moveLeft = view.root.findAll((node) => node.props.children === "Move Left")[0]!;
    const moveRight = view.root.findAll((node) => node.props.children === "Move Right")[0]!;
    expect(moveLeft.props.disabled).toBe(false);
    expect(moveRight.props.disabled).toBe(false);

    act(() => moveRight.props.onClick());
    expect(onReorder).toHaveBeenCalledWith("chat", "agents");
    view.unmount();
    client.clear();
  });
});
