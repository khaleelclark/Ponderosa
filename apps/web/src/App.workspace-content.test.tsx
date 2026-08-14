import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkspaceRouteOutlet } from "./App.workspace-content";

vi.mock("./components/RecoverableLazyRoute", () => ({
  RecoverableLazyRoute: ({ componentProps }: {
    componentProps: {
      projectId?: string;
      onProjectDeleted?(projectId: string): void;
    };
  }) => componentProps.projectId && componentProps.onProjectDeleted
    ? (
        <button
          onClick={() => componentProps.onProjectDeleted!(componentProps.projectId!)}
        >
          Complete Project deletion
        </button>
      )
    : <div />,
}));

afterEach(cleanup);

describe("open Project deletion completion", () => {
  test("routes completion to the canonical Project callback, not resource-tab cleanup", () => {
    const project = {
      id: "project-1",
      label: "Open Project",
      hostPath: "/tmp/open-project",
      createdAt: "2026-08-14T00:00:00.000Z",
      defaultEngine: "codex",
    } satisfies ProjectDto;
    const onProjectDeleted = vi.fn();
    const onResourceDeleted = vi.fn();
    render(
      <WorkspaceRouteOutlet
        route={{ kind: "project", projectId: project.id }}
        selectedProjectId={project.id}
        projectResolution="unavailable"
        onRetryProject={() => undefined}
        projects={[project]}
        engines={[]}
        notifications={[]}
        preferences={{} as WorkspacePreferencesDto}
        colorMode="light"
        loadError={false}
        onRetryLoad={() => undefined}
        onNavigate={() => undefined}
        onPreferences={() => undefined}
        onCreate={() => undefined}
        onCancelCreate={() => undefined}
        onOpenInbox={() => undefined}
        onProjectDeleted={onProjectDeleted}
        onConversationAction={() => undefined}
        onOpenEngineStatus={() => undefined}
        onBrowserRequestHandled={() => undefined}
        onResourceDeleted={onResourceDeleted}
        onToggleColorMode={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Complete Project deletion" }));
    expect(onProjectDeleted).toHaveBeenCalledWith(project.id);
    expect(onResourceDeleted).not.toHaveBeenCalled();
  });
});
