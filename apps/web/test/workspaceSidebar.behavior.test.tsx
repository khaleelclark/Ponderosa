import type {
  ProjectDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import type { Route } from "../src/routing";

const preferences = {
  projectSort: "custom",
  projectOrder: [],
  homeSort: "custom",
  homeOrder: [],
  chatSort: "custom",
  chatOrder: [],
  agentSort: "custom",
  agentOrder: [],
  triggerSort: "custom",
  triggerOrder: [],
  starredProjectIds: [],
  starredResourceIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 390,
  notifications: {
    mentions: true,
    directReplies: true,
    projectChatMessages: true,
    broadcasts: true,
    allMessages: false,
  },
  fontFamily: "inter",
  providerAvailability: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  contextRolloverEnabled: true,
  contextRolloverTokens: 100_000,
  contextRolloverWindowFraction: 0.8,
  onboardingCompletedAt: "2026-07-17T00:00:00.000Z",
  profile: {
    displayName: "User",
    handle: "operator",
    avatarId: "default-user",
  },
  updatedAt: "2026-07-17T00:00:00.000Z",
} satisfies WorkspacePreferencesDto;

const projects: ProjectDto[] = [
  {
    id: "alpha",
    label: "Alpha",
    hostPath: "/repos/alpha",
    defaultEngine: "codex",
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "beta",
    label: "Beta",
    hostPath: "/repos/beta",
    defaultEngine: "codex",
    createdAt: "2026-07-02T00:00:00.000Z",
  },
];

function workspaceClient(projectList: readonly ProjectDto[] = []): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
    },
  });
  client.setQueryData(["triggers"], []);
  client.setQueryData(["wiki", "index"], {
    sections: [
      {
        id: "guide",
        title: "Guide",
        articles: [
          {
            id: "overview",
            title: "Overview",
            summary: "Start here",
          },
          {
            id: "runtime",
            title: "Runtime",
            summary: "Run behavior",
          },
        ],
      },
    ],
  });
  projectList.forEach(project => {
    client.setQueryData(["conversations", project.id], []);
    client.setQueryData(["agents", project.id], []);
    client.setQueryData(["agent-health", project.id], {
      scope: { type: "project", id: project.id },
      generatedAt: "2026-07-17T00:00:00.000Z",
      agents: [],
    });
  });
  return client;
}

interface SidebarTestProps {
  client: QueryClient;
  route: Route;
  projects?: ProjectDto[];
  preferences?: WorkspacePreferencesDto;
  collapsed?: boolean;
  width?: number;
  onCollapsedChange?(collapsed: boolean): void;
  onWidthChange?(width: number): void;
}

function sidebar({
  client,
  route,
  projects: projectList = [],
  preferences: workspacePreferences = preferences,
  collapsed = false,
  width = 390,
  onCollapsedChange,
  onWidthChange,
}: SidebarTestProps): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <WorkspaceSidebar
        projects={projectList}
        preferences={workspacePreferences}
        route={route}
        notifications={[]}
        onNavigate={vi.fn()}
        onCreateProject={vi.fn()}
        onPreferences={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        collapsed={collapsed}
        width={width}
        onCollapsedChange={onCollapsedChange}
        onWidthChange={onWidthChange}
      />
    </QueryClientProvider>
  );
}

function pointerEvent(type: string, clientX: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkspaceSidebar public behavior", () => {
  it("preserves Wiki filter state for same-kind route changes and clears it when the route-kind effect re-fires", async () => {
    const client = workspaceClient();
    const user = userEvent.setup();
    const view = render(sidebar({
      client,
      route: { kind: "wiki", articleId: "overview" },
    }));

    const filter = screen.getByRole("textbox", { name: "Search Wiki" });
    await user.type(filter, "runtime");
    expect((filter as HTMLInputElement).value).toBe("runtime");

    view.rerender(sidebar({
      client,
      route: { kind: "wiki", articleId: "runtime" },
    }));
    expect((
      screen.getByRole("textbox", { name: "Search Wiki" }) as HTMLInputElement
    ).value).toBe("runtime");

    view.rerender(sidebar({
      client,
      route: { kind: "settings", section: "general" },
    }));
    expect(screen.getByText("General")).not.toBeNull();

    view.rerender(sidebar({
      client,
      route: { kind: "wiki", articleId: "overview" },
    }));
    expect((
      screen.getByRole("textbox", { name: "Search Wiki" }) as HTMLInputElement
    ).value).toBe("");

    view.unmount();
    render(sidebar({
      client,
      route: { kind: "wiki", articleId: "runtime" },
    }));
    expect((
      screen.getByRole("textbox", { name: "Search Wiki" }) as HTMLInputElement
    ).value).toBe("");
    client.clear();
  });

  it("keeps panel selection across controlled collapse changes while the parent owns the open state", async () => {
    const client = workspaceClient();
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    const view = render(sidebar({
      client,
      route: { kind: "projects" },
      onCollapsedChange,
    }));

    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(view.container.querySelector('[data-sidebar-panel="agents"]'))
      .not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
    expect(view.container.querySelector('[data-sidebar-panel="agents"]'))
      .not.toBeNull();

    view.rerender(sidebar({
      client,
      route: { kind: "projects" },
      collapsed: true,
      onCollapsedChange,
    }));
    expect(screen.getByLabelText("Workspace navigation")
      .getAttribute("data-sidebar-state")).toBe("collapsed");
    expect(view.container.querySelector("[data-sidebar-panel]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);

    view.rerender(sidebar({
      client,
      route: { kind: "projects" },
      collapsed: false,
      onCollapsedChange,
    }));
    expect(view.container.querySelector('[data-sidebar-panel="agents"]'))
      .not.toBeNull();
    client.clear();
  });

  it("preserves focused row identity when custom project order changes", () => {
    const client = workspaceClient(projects);
    const view = render(sidebar({
      client,
      route: { kind: "projects" },
      projects,
      preferences: {
        ...preferences,
        projectOrder: ["alpha", "beta"],
      },
    }));

    const alphaBefore = screen.getByRole("button", {
      name: "Open project Alpha",
    });
    alphaBefore.focus();
    expect(document.activeElement).toBe(alphaBefore);

    view.rerender(sidebar({
      client,
      route: { kind: "projects" },
      projects,
      preferences: {
        ...preferences,
        projectOrder: ["beta", "alpha"],
      },
    }));

    const alphaAfter = screen.getByRole("button", {
      name: "Open project Alpha",
    });
    const rows = screen.getAllByRole("button", {
      name: /Open project (Alpha|Beta)/u,
    });
    expect(rows.map(row => row.getAttribute("aria-label"))).toEqual([
      "Open project Beta",
      "Open project Alpha",
    ]);
    expect(alphaAfter).toBe(alphaBefore);
    expect(document.activeElement).toBe(alphaAfter);
    client.clear();
  });

  it("uses the pointer-down width snapshot and removes all resize listeners on pointer completion", () => {
    const client = workspaceClient();
    const onWidthChange = vi.fn();
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(sidebar({
      client,
      route: { kind: "projects" },
      width: 400,
      onWidthChange,
    }));
    const separator = screen.getByRole("separator", {
      name: "Resize sidebar",
    });
    const addCallStart = addEventListener.mock.calls.length;

    fireEvent(separator, pointerEvent("pointerdown", 100));
    expect(screen.getByLabelText("Workspace navigation")
      .getAttribute("data-sidebar-resizing")).toBe("true");
    const resizeAdds = addEventListener.mock.calls.slice(addCallStart)
      .filter(([name]) =>
        name === "pointermove" ||
        name === "pointerup" ||
        name === "pointercancel");
    expect(resizeAdds.map(([name]) => name)).toEqual([
      "pointermove",
      "pointerup",
      "pointercancel",
    ]);

    view.rerender(sidebar({
      client,
      route: { kind: "projects" },
      width: 320,
      onWidthChange,
    }));
    fireEvent(window, pointerEvent("pointermove", 200));
    expect(onWidthChange).toHaveBeenLastCalledWith(500);

    const removeCallStart = removeEventListener.mock.calls.length;
    fireEvent(window, pointerEvent("pointerup", 200));
    expect(screen.getByLabelText("Workspace navigation")
      .getAttribute("data-sidebar-resizing")).toBe("false");
    const resizeRemoves = removeEventListener.mock.calls.slice(removeCallStart)
      .filter(([name]) =>
        name === "pointermove" ||
        name === "pointerup" ||
        name === "pointercancel");
    expect(resizeRemoves.map(([name]) => name)).toEqual([
      "pointermove",
      "pointerup",
      "pointercancel",
    ]);
    expect(resizeRemoves.map(([, listener]) => listener)).toEqual(
      resizeAdds.map(([, listener]) => listener),
    );

    onWidthChange.mockClear();
    fireEvent(window, pointerEvent("pointermove", 300));
    expect(onWidthChange).not.toHaveBeenCalled();
    client.clear();
  });

  it("releases an active pointer-resize listener when unmounted before pointer completion", () => {
    const client = workspaceClient();
    const onWidthChange = vi.fn();
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(sidebar({
      client,
      route: { kind: "projects" },
      width: 400,
      onWidthChange,
    }));

    fireEvent(
      screen.getByRole("separator", { name: "Resize sidebar" }),
      pointerEvent("pointerdown", 100),
    );
    const removeCallStart = removeEventListener.mock.calls.length;
    view.unmount();

    const resizeRemovesAtUnmount = removeEventListener.mock.calls
      .slice(removeCallStart)
      .filter(([name]) =>
        name === "pointermove" ||
        name === "pointerup" ||
        name === "pointercancel");
    expect(resizeRemovesAtUnmount.map(([name]) => name)).toEqual([
      "pointermove",
      "pointerup",
      "pointercancel",
    ]);

    // The drag is over because the sidebar is gone: no later pointer event
    // reaches the width handler.
    fireEvent(window, pointerEvent("pointermove", 180));
    expect(onWidthChange).not.toHaveBeenCalled();
    fireEvent(window, pointerEvent("pointercancel", 180));
    expect(onWidthChange).not.toHaveBeenCalled();
    client.clear();
  });
});
