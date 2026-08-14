import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AllChatPageDto,
  ProjectDto,
  WorkspaceEventEnvelope,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { queryKeys } from "../queryKeys";
import {
  reconcileDeletedProjectClientState,
  reconcileDeletedProjectEvent,
} from "../hooks/useWorkspaceStream";
import { AllChatView } from "./AllChatView";

const { getAllChat } = vi.hoisted(() => ({
  getAllChat: vi.fn(),
}));

vi.mock("../api", () => ({ api: { getAllChat } }));
vi.mock("./AttentionSurface", () => ({ AttentionSurface: () => null }));
vi.mock("./WorkspaceFrame", () => ({
  CompactWorkspaceHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("./chat/ChatSurface", () => ({
  ChatSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./chat/ChatMessageFrame", () => ({
  ChatMessageFrame: ({ message }: {
    message: { ariaLabel: string; body: React.ReactNode; afterBody?: React.ReactNode };
  }) => <article aria-label={message.ariaLabel}>{message.body}{message.afterBody}</article>,
}));
vi.mock("./chat/ChatMessages", () => ({
  authoredAgentMentionForHandle: () => undefined,
  communicationVisibleText: ({ text }: { text: string }) => text,
  showBroadcastBadge: () => false,
  ChatMessageBody: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("./chat/ChatComposerDock", () => ({ ChatComposerDock: () => null }));
vi.mock("./decisions/DecisionCard", () => ({ DecisionCard: () => null }));
vi.mock("./AgentDetail.parts", () => ({ AgentRuntimeControls: () => null }));
vi.mock("./useConversationNotificationVisibility", () => ({
  useConversationNotificationVisibility: () => () => undefined,
}));
vi.mock("../hooks/useRuntimeControls", () => ({
  useRuntimeControls: () => ({
    model: "",
    models: [],
    effort: "",
    efforts: [],
    speed: "",
    speeds: [],
  }),
}));

const deletedProject = {
  id: "project-deleted",
  label: "Deleted Project",
  hostPath: "/tmp/deleted",
  createdAt: "2026-08-14T00:00:00.000Z",
  defaultEngine: "codex",
} satisfies ProjectDto;

const availableProject = {
  ...deletedProject,
  id: "project-available",
  label: "Available Project",
  hostPath: "/tmp/available",
} satisfies ProjectDto;

function item(project: ProjectDto, index: number): AllChatPageDto["items"][number] {
  return {
    communicationEventId: `communication-${index}`,
    messageId: `message-${index}`,
    communicationIntent: "broadcast",
    project: { id: project.id, label: project.label },
    source: {
      kind: "project",
      conversationId: `conversation-${index}`,
      title: `${project.label} Chat`,
    },
    author: { kind: "user", label: "Patrick" },
    text: `${project.label} message`,
    createdAt: `2026-08-14T00:0${index}:00.000Z`,
  };
}

const initialPage: AllChatPageDto = {
  items: [item(deletedProject, 0), item(availableProject, 1)],
  history: { limit: 50, hasMore: false },
};

const repairedPage: AllChatPageDto = {
  items: [item(availableProject, 1)],
  history: { limit: 50, hasMore: false },
};

const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  chatSort: "alphabetical",
  chatOrder: [],
  starredProjectIds: [],
  starredResourceIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 280,
  notifications: { directResponses: true, broadcasts: true },
  fontFamily: "inter",
  profile: { displayName: "Patrick", handle: "pto", avatarId: "" },
  providerAvailability: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 4,
  contextRolloverEnabled: true,
  contextRolloverTokens: 100_000,
  contextRolloverWindowFraction: 0.8,
  onboardingCompletedAt: null,
  updatedAt: "2026-08-14T00:00:00.000Z",
} satisfies WorkspacePreferencesDto;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("active All Chat external Project deletion", () => {
  test("removes dead rows before refetch and leaves no dead navigation target", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.allChat(50), initialPage);
    queryClient.setQueryData(queryKeys.projects.all, [deletedProject, availableProject]);
    queryClient.setQueryData(queryKeys.workspacePreferences.all, preferences);
    queryClient.setQueryData(queryKeys.engines.all, []);
    getAllChat.mockImplementation(() => new Promise<AllChatPageDto>(() => undefined));
    const onNavigate = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <AllChatView onNavigate={onNavigate} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Deleted Project message")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deleted Project Chat" })).toBeTruthy();

    const envelope = {
      id: 42,
      ts: "2026-08-14T04:00:00.000Z",
      event: {
        type: "project_changed",
        projectId: deletedProject.id,
        action: "deleted",
      },
    } satisfies WorkspaceEventEnvelope;
    act(() => {
      reconcileDeletedProjectEvent(envelope, (projectId, at) => {
        reconcileDeletedProjectClientState(queryClient, projectId, at);
      });
    });

    expect(queryClient.getQueryData<AllChatPageDto>(queryKeys.allChat(50)))
      .toEqual(repairedPage);
    await waitFor(() => {
      expect(screen.queryByText("Deleted Project message")).toBeNull();
      expect(screen.queryByRole("button", { name: "Deleted Project Chat" })).toBeNull();
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(getAllChat).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Available Project Chat" }));
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "conversation",
      projectId: availableProject.id,
      conversationId: "conversation-1",
      focusMessageId: "communication-1",
    });
  });
});
