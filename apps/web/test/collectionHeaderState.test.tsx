import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { WorkspacePreferencesDto } from "@ponderosa/core";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AllProjectsView } from "../src/components/WorkspaceOverview";
import {
  AllAgentsWorkspace,
  AllChatsWorkspace,
  AllTriggersWorkspace,
} from "../src/components/WorkspaceResourceViews";
import type { WorkspaceDirectoryRequestState } from "../src/hooks/useWorkspaceDirectory";

const useWorkspaceDirectoryMock = vi.hoisted(() => vi.fn());

vi.mock("../src/hooks/useWorkspaceDirectory", async () => {
  const actual = await vi.importActual<
    typeof import("../src/hooks/useWorkspaceDirectory")
  >("../src/hooks/useWorkspaceDirectory");
  return {
    ...actual,
    useWorkspaceDirectory: useWorkspaceDirectoryMock,
  };
});

vi.mock("../src/hooks/useProjectCollections", () => ({
  useProjectAgents: () => [],
  useProjectConversations: () => [],
  useProjectAgentHealth: () => [],
}));

const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  chatSort: "last_used",
  chatOrder: [],
  agentSort: "last_used",
  agentOrder: [],
  triggerSort: "last_used",
  triggerOrder: [],
  starredResourceIds: [],
  starredProjectIds: [],
} as unknown as WorkspacePreferencesDto;

function requestState(
  override: Partial<WorkspaceDirectoryRequestState>,
): WorkspaceDirectoryRequestState {
  return {
    hasResolved: false,
    isInitialLoading: false,
    isRefreshing: false,
    isInitialError: false,
    isPaginationError: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    retry: vi.fn().mockResolvedValue(undefined),
    fetchNextPage: vi.fn().mockResolvedValue(undefined),
    ...override,
  };
}

function renderCollection(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
}

const cases = [
  {
    heading: "All Projects",
    render: () => (
      <AllProjectsView
        projects={[]}
        preferences={preferences}
        onNavigate={vi.fn()}
        onCreateProject={vi.fn()}
        onProjectDeleted={vi.fn()}
        onPreferences={vi.fn()}
      />
    ),
  },
  {
    heading: "All Chats",
    render: () => (
      <AllChatsWorkspace
        projects={[]}
        preferences={preferences}
        onPreferences={vi.fn()}
        onNavigate={vi.fn()}
        onCreate={vi.fn()}
        onConversationAction={vi.fn()}
      />
    ),
  },
  {
    heading: "All Agents",
    render: () => (
      <AllAgentsWorkspace
        projects={[]}
        engines={[]}
        preferences={preferences}
        onPreferences={vi.fn()}
        onNavigate={vi.fn()}
        onCreate={vi.fn()}
        onAgentsDeleted={vi.fn()}
      />
    ),
  },
  {
    heading: "All Triggers",
    render: () => (
      <AllTriggersWorkspace
        projects={[]}
        preferences={preferences}
        onPreferences={vi.fn()}
        onNavigate={vi.fn()}
        onCreate={vi.fn()}
      />
    ),
  },
] as const;

describe("collection workspace header totals", () => {
  for (const unresolved of [
    { label: "initial loading", state: { isInitialLoading: true } },
    { label: "initial failure", state: { isInitialError: true } },
  ]) {
    it(`omits false zero totals during ${unresolved.label}`, () => {
      useWorkspaceDirectoryMock.mockReturnValue({
        data: undefined,
        requestState: requestState(unresolved.state),
      });
      for (const collection of cases) {
        const view = renderCollection(collection.render());
        expect(
          screen.getByRole("heading", { name: collection.heading }),
        ).not.toBeNull();
        expect(screen.queryByText(/^0 .*Ponderosa$/)).toBeNull();
        view.unmount();
      }
    });
  }
});
