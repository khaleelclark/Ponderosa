import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { AllProjectsView } from "../src/components/WorkspaceOverview";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    IconButton: forwardRef<HTMLButtonElement, Record<string, unknown> & { children?: React.ReactNode }>(
      ({ children, sx: _sx, ...props }, ref) => createElement("button", { ...props, ref }, children),
    ),
    TextField: forwardRef<HTMLInputElement, Record<string, unknown>>(
      ({ InputProps: _inputProps, children: _children, select: _select, sx: _sx, ...props }, ref) =>
        createElement("input", { ...props, ref }),
    ),
    Tooltip: ({ children }: { children: React.ReactElement }) => children,
  };
});

const projects: ProjectDto[] = [
  { id: "alpha", label: "Alpha", hostPath: "/alpha", defaultEngine: "codex", createdAt: "2026-07-01T00:00:00.000Z" },
  { id: "beta", label: "Beta", hostPath: "/beta", defaultEngine: "codex", createdAt: "2026-07-02T00:00:00.000Z" },
  { id: "gamma", label: "Gamma", hostPath: "/gamma", defaultEngine: "codex", createdAt: "2026-07-03T00:00:00.000Z" },
];

const basePreferences = {
  projectSort: "last_used",
  projectOrder: [],
  starredProjectIds: [],
  starredResourceIds: [],
} as unknown as WorkspacePreferencesDto;

describe("accessible project ordering", () => {
  it("persists a custom move, announces the position, retains focus, and keeps controls at narrow widths", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    projects.forEach((project) => {
      client.setQueryData(["conversations", project.id], []);
      client.setQueryData(["agents", project.id], []);
      client.setQueryData(["agent-health", project.id], { agents: [] });
    });
    const patches: Partial<WorkspacePreferencesDto>[] = [];
    const focused: string[] = [];

    function Harness(): JSX.Element {
      const [orderedProjects, setOrderedProjects] = useState(projects);
      const [preferences, setPreferences] = useState(basePreferences);
      return <AllProjectsView
        projects={orderedProjects}
        preferences={preferences}
        onNavigate={vi.fn()}
        onCreateProject={vi.fn()}
        onManageProject={vi.fn()}
        onPreferences={(patch) => {
          patches.push(patch);
          setPreferences((current) => ({ ...current, ...patch }));
          if (patch.projectOrder) {
            const byId = new Map(orderedProjects.map((project) => [project.id, project]));
            setOrderedProjects(patch.projectOrder.map((id) => byId.get(id)!).filter(Boolean));
          }
        }}
      />;
    }

    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><Harness /></QueryClientProvider>, {
        createNodeMock: (element) => element.type === "button" ? {
          disabled: element.props.disabled,
          focus: () => focused.push(String(element.props["aria-label"])),
        } : {},
      });
    });

    const moveBetaBeforeAlpha = view.root.findByProps({ "aria-label": "Move Beta before Alpha" });
    expect(moveBetaBeforeAlpha.props["aria-describedby"]).toBe("project-order-status");
    act(() => moveBetaBeforeAlpha.props.onClick());

    expect(patches.at(-1)).toEqual({
      projectSort: "custom",
      projectOrder: ["beta", "alpha", "gamma"],
    });
    expect(view.root.findByProps({ id: "project-order-status" }).props.children).toBe("Beta moved to position 1 of 3.");
    expect(focused.at(-1)).toBe("Move Beta after Alpha");
    expect(view.root.findAll((node) =>
      node.props.direction?.xs === "column" && node.props.direction?.sm === "row",
    ).length).toBeGreaterThan(0);
    expect(view.root.findByProps({ "aria-label": "Move Alpha before Beta" })).toBeTruthy();

    view.unmount();
    client.clear();
  });
});
