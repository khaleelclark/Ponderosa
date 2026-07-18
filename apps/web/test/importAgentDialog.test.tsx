import { Button, Checkbox, Select, TextField, Typography } from "@mui/material";
import type { AgentPortablePackageDto, ConversationDto, EngineDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ImportAgentDialog } from "../src/components/ImportAgentDialog";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: React.ReactNode }>(({ open, children }, ref) =>
      open ? createElement("div", { ref }, children) : null),
    Button: forwardRef<HTMLButtonElement, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      createElement("button", { ...props, ref }, children)),
    Checkbox: forwardRef<HTMLInputElement, Record<string, unknown>>((props, ref) =>
      createElement("input", { ...props, ref, type: "checkbox" })),
    Select: forwardRef<HTMLSelectElement, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      createElement("select", { ...props, ref }, children)),
    MenuItem: forwardRef<HTMLOptionElement, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      createElement("option", { ...props, ref }, children)),
    TextField: forwardRef<HTMLTextAreaElement, Record<string, unknown>>((props, ref) =>
      createElement("textarea", { ...props, ref })),
  };
});

describe("Agent package import review", () => {
  it("discloses and requires acknowledgement of elevated management permissions", async () => {
    const portablePackage = {
      schema: "ponderosa.agent-package.v1",
      mode: "full",
      kind: "organization",
      exportedAt: "2026-07-18T00:00:00.000Z",
      sourceLabel: "Elevated team",
      rootRef: "manager",
      agents: [{
        ref: "manager",
        title: "Manager",
        engine: "codex",
        managementPermissions: {
          allowAutomaticDescendantDeletion: true,
          allowAutomaticDescendantReorganization: false,
        },
      }],
    } satisfies AgentPortablePackageDto;
    const conversation = {
      id: "chat-1", projectId: "project-1", title: "Home", createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z", archived: false,
    } satisfies ConversationDto;
    const engine = {
      id: "codex", displayName: "Codex", models: [], efforts: [], configured: true,
      authenticated: true, available: true,
    } satisfies EngineDto;
    const imported = vi.spyOn(api, "importAgents").mockResolvedValue({
      rootAgentId: "imported-manager", agentIds: ["imported-manager"], refMap: { manager: "imported-manager" },
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ImportAgentDialog
        open projectId="project-1" engines={[engine]} conversations={[conversation]}
        onClose={() => undefined} onImported={() => undefined}
      /></QueryClientProvider>);
    });

    await act(async () => {
      view.root.findByType(TextField).props.onChange({ target: { value: JSON.stringify(portablePackage) } });
    });
    const engineSelect = view.root.findAllByType(Select).find((item) => item.props.label === "Map codex")!;
    await act(async () => { engineSelect.props.onChange({ target: { value: "codex" } }); });
    expect(view.root.findAllByType(Typography).some((item) =>
      String(item.props.children).includes("autonomously delete descendants or rearrange their organization"))).toBe(true);
    const importButton = view.root.findAllByType(Button).find((item) => item.props.variant === "contained")!;
    expect(importButton.props.disabled).toBe(true);

    await act(async () => { view.root.findByType(Checkbox).props.onChange({ target: { checked: true } }); });
    expect(view.root.findAllByType(Button).find((item) => item.props.variant === "contained")!.props.disabled).toBe(false);
    await act(async () => { view.root.findAllByType(Button).find((item) => item.props.variant === "contained")!.props.onClick(); });

    expect(imported).toHaveBeenCalledWith("project-1", expect.objectContaining({
      package: portablePackage,
      conversationId: conversation.id,
      engineMapping: { codex: "codex" },
      acknowledgeElevatedManagementPermissions: true,
    }));
    view.unmount();
    client.clear();
  });
});
