// @vitest-environment node

import { Button, TextField } from "@mui/material";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  ConfirmDialog,
  DestructiveConfirmDialog,
  TextInputDialog,
} from "../src/components/ConfirmationDialogs";

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
      createElement("input", { ref, value: props.value, "aria-label": props.label, "aria-invalid": props.error, onChange: props.onChange, onKeyDown: props.onKeyDown, autoFocus: props.autoFocus, disabled: props.disabled, "data-helper": props.helperText })),
  };
});

describe("shared confirmation dialogs", () => {
  it("keeps destructive cancellation available, focuses confirmation, and locks dismissal while pending", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const render = (pending: boolean, error?: string) => (
      <DestructiveConfirmDialog
        open
        title="Delete Project?"
        confirmLabel="Delete Permanently"
        pendingLabel="Deleting…"
        pending={pending}
        error={error}
        onCancel={onCancel}
        onConfirm={onConfirm}
      >
        Permanent consequence copy
      </DestructiveConfirmDialog>
    );
    const view = create(render(false));
    const confirm = view.root.findAllByType(Button).find((button) => button.props.children === "Delete Permanently")!;
    expect(confirm.props.autoFocus).toBe(true);
    expect(confirm.props.color).toBe("error");
    act(() => view.root.findAllByType(Button).find((button) => button.props.children === "Cancel")!.props.onClick());
    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => view.update(render(true, "Deletion failed")));
    expect(view.root.findByProps({ role: "dialog" }).props["aria-busy"]).toBe(true);
    expect(view.root.findAllByType(Button).every((button) => button.props.disabled)).toBe(true);
    expect(JSON.stringify(view.toJSON())).toContain("Deletion failed");
    view.unmount();
  });

  it("validates text inline and submits without using a native prompt", () => {
    const onConfirm = vi.fn();
    const view = create(
      <TextInputDialog
        open
        title="Allow more automatic Runs"
        label="Additional Runs"
        initialValue="0"
        confirmLabel="Allow Runs"
        onCancel={vi.fn()}
        validate={(value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? undefined : "Enter a positive whole number."}
        onConfirm={onConfirm}
      />,
    );
    act(() => undefined);
    const field = view.root.findByType(TextField);
    expect(field.props.autoFocus).toBe(true);
    expect(field.props.error).toBe(true);
    expect(field.props.helperText).toBe("Enter a positive whole number.");
    expect(view.root.findAllByType(Button).find((button) => button.props.children === "Allow Runs")!.props.disabled).toBe(true);

    act(() => field.props.onChange({ target: { value: "5" } }));
    act(() => view.root.findAllByType(Button).find((button) => button.props.children === "Allow Runs")!.props.onClick());
    expect(onConfirm).toHaveBeenCalledWith("5");
    view.unmount();
  });

  it("uses the same non-destructive shell for provider access confirmation", () => {
    const view = create(
      <ConfirmDialog
        open
        title="Test Codex access?"
        confirmLabel="Test Access"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      >
        This sends one minimal subscription-backed request.
      </ConfirmDialog>,
    );
    expect(JSON.stringify(view.toJSON())).toContain("minimal subscription-backed request");
    expect(view.root.findAllByType(Button).find((button) => button.props.children === "Test Access")!.props.color).toBe("primary");
    view.unmount();
  });
});
