import { Button, TextField } from "@mui/material";
import type { EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorProfileDialog } from "../src/components/OperatorProfileDialog";
import { ProjectCreationDialog } from "../src/components/ProjectCreationDialog";
import { ProjectSettingsDialog } from "../src/components/ProjectSettingsDialog";
import { ConfirmDialog, DestructiveConfirmDialog } from "../src/components/ConfirmationDialogs";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: ReactNode; "aria-busy"?: boolean }>(({ open, children, ...props }, ref) =>
      open ? createElement("div", { ...props, ref, role: "dialog" }, children) : null),
    Button: forwardRef<HTMLButtonElement, Record<string, unknown> & { children?: ReactNode; startIcon?: ReactNode }>(({ children, startIcon, ...props }, ref) =>
      createElement("button", { ...props, ref }, startIcon, children)),
    TextField: forwardRef<HTMLInputElement, Record<string, unknown> & { helperText?: ReactNode }>((props, ref) =>
      createElement("input", { ref, value: props.value, "aria-label": props.label, "aria-invalid": props.error, onChange: props.onChange, autoFocus: props.autoFocus, disabled: props.disabled, "data-helper": props.helperText })),
    Select: forwardRef<HTMLDivElement, { children?: ReactNode }>(({ children, ...props }, ref) =>
      createElement("div", { ...props, ref, role: "listbox" }, children)),
    MenuItem: forwardRef<HTMLDivElement, { children?: ReactNode }>(({ children, ...props }, ref) =>
      createElement("div", { ...props, ref, role: "option" }, children)),
  };
});

const engines: EngineDto[] = [{
  id: "codex",
  displayName: "Codex",
  models: [{ id: "gpt-5", label: "GPT-5" }],
  efforts: [],
  configured: true,
  enabled: true,
  authenticated: true,
  available: false,
  availabilityDetail: "Access needs to be checked.",
}];
const project: ProjectDto = {
  id: "project",
  label: "Ponderosa",
  hostPath: "/repos/ponderosa",
  defaultEngine: "codex",
  createdAt: "2026-07-01T00:00:00.000Z",
};
const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  homeSort: "last_used",
  homeOrder: [],
  chatSort: "last_used",
  chatOrder: [],
  agentSort: "last_used",
  agentOrder: [],
  triggerSort: "last_used",
  triggerOrder: [],
  starredProjectIds: [],
  starredResourceIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 288,
  notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false },
  fontFamily: "inter",
  providerAvailability: {},
  engineDefaults: {},
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
  profile: { displayName: "Patrick", handle: "pto", avatarId: "default-user" },
  updatedAt: "2026-07-01T00:00:00.000Z",
} as WorkspacePreferencesDto;

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}

describe("application shell feature dialogs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders provider access as a confirmation-backed project creation action", () => {
    const queryClient = client();
    const view = create(<QueryClientProvider client={queryClient}><ProjectCreationDialog
      open
      engines={engines}
      preferences={preferences}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    /></QueryClientProvider>);
    act(() => undefined);
    expect(view.root.findAll((node) => node.children.includes("Default AI Runtime"))).not.toHaveLength(0);
    expect(view.root.findByProps({ label: "Project Name" }).props.autoFocus).toBe(true);
    expect(view.root.findAllByType(Button).some((button) => button.props.children === "Test Access")).toBe(true);
    expect(view.root.findByType(ConfirmDialog).props.confirmLabel).toBe("Test Access");
    view.unmount();
    queryClient.clear();
  });

  it("keeps Project import visible and configures an explicit destructive confirmation", () => {
    const queryClient = client();
    const view = create(<QueryClientProvider client={queryClient}><ProjectSettingsDialog
      project={project}
      engines={engines}
      preferences={preferences}
      onClose={vi.fn()}
      onDeleted={vi.fn()}
      onImported={vi.fn()}
    /></QueryClientProvider>);
    act(() => undefined);
    expect(view.root.findAllByType(Button).some((button) => button.props.children === "Import Agent or Organization")).toBe(true);
    const destructive = view.root.findByType(DestructiveConfirmDialog);
    expect(destructive.props.title).toBe("Delete this project?");
    expect(destructive.props.confirmLabel).toBe("Delete Permanently");
    view.unmount();
    queryClient.clear();
  });

  it("renders focused profile fields and rejects reserved handles", () => {
    const view = create(<OperatorProfileDialog
      open
      profile={{ ...preferences.profile, handle: "user" }}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />);
    act(() => undefined);
    expect(view.root.findAll((node) => node.children.some((child) => typeof child === "string" && child.includes("HEIC is not accepted")))).not.toHaveLength(0);
    expect(view.root.findAllByType(TextField).find((field) => field.props.label === "What Agents call you")!.props.autoFocus).toBe(true);
    expect(view.root.findAllByType(Button).find((button) => button.props.children === "Save Profile")!.props.disabled).toBe(true);
    view.unmount();
  });
});
