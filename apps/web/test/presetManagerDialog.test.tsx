// @vitest-environment node

import { Button, Select } from "@mui/material";
import type { AgentPresetDto, EngineDto } from "@ponderosa/core";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { DestructiveConfirmDialog } from "../src/components/ConfirmationDialogs";
import { PresetManagerDialog } from "../src/components/dialogs";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: ReactNode }>(({ open, children, ...props }, ref) =>
      open ? createElement("div", { ...props, ref, role: "dialog" }, children) : null),
    Button: forwardRef<HTMLButtonElement, Record<string, unknown> & { children?: ReactNode }>(({ children, ...props }, ref) =>
      createElement("button", { ...props, ref }, children)),
    Select: forwardRef<HTMLDivElement, Record<string, unknown> & { children?: ReactNode }>(({ children, ...props }, ref) =>
      createElement("div", { ...props, ref, role: "listbox" }, children)),
    MenuItem: forwardRef<HTMLDivElement, Record<string, unknown> & { children?: ReactNode }>(({ children, ...props }, ref) =>
      createElement("div", { ...props, ref, role: "option" }, children)),
  };
});

const engine: EngineDto = {
  id: "codex",
  displayName: "Codex",
  models: [{ id: "gpt-5", label: "GPT-5" }],
  efforts: [{ id: "high", label: "High" }],
  configured: true,
  enabled: true,
  authenticated: true,
  available: true,
};

const preset: AgentPresetDto = {
  id: "preset-1",
  projectId: "project-1",
  name: "Reviewer",
  description: "Reviews implementation changes",
  guidance: "Review each implementation carefully.",
  engine: "codex",
  model: "retired-model",
  effort: "retired-effort",
  enabled: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function renderDialog(overrides: {
  onSave?: ReturnType<typeof vi.fn>;
  onDelete?: ReturnType<typeof vi.fn>;
} = {}) {
  return create(<PresetManagerDialog
    open
    engines={[engine]}
    presets={[preset]}
    onClose={vi.fn()}
    onSave={overrides.onSave ?? vi.fn().mockResolvedValue(undefined)}
    onDelete={overrides.onDelete ?? vi.fn().mockResolvedValue(undefined)}
  />);
}

function editPreset(view: ReturnType<typeof create>): void {
  act(() => {
    view.root.findByProps({ primary: "Reviewer" }).props.onClick();
  });
}

describe("PresetManagerDialog", () => {
  it("falls back to default values when stored model and effort options are no longer advertised", () => {
    const view = renderDialog();
    editPreset(view);

    expect(view.root.findAllByType(Select).find((select) => select.props.label === "Model")?.props.value).toBe("");
    expect(view.root.findAllByType(Select).find((select) => select.props.label === "Effort")?.props.value).toBe("");
    view.unmount();
  });

  it("confirms deletion and keeps a failed delete visible in the shared dialog", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("Delete failed"));
    const view = renderDialog({ onDelete });
    act(() => {
      view.root.findAllByType(Button).find((button) => button.props.children === "Delete")!.props.onClick();
    });

    expect(view.root.findByType(DestructiveConfirmDialog).props.title).toBe("Delete preset?");
    act(() => {
      view.root.findByType(DestructiveConfirmDialog).props.onConfirm();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onDelete).toHaveBeenCalledWith("preset-1");
    expect(view.root.findByType(DestructiveConfirmDialog).props.error).toContain("Delete failed");
    view.unmount();
  });

  it("surfaces save failures without closing the editor", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Save failed"));
    const view = renderDialog({ onSave });
    editPreset(view);
    act(() => {
      view.root.findAllByType(Button).find((button) => button.props.children === "Save Changes")!.props.onClick();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onSave).toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).toContain("Save failed");
    view.unmount();
  });
});
