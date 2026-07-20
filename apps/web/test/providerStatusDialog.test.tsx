import type { EngineDto } from "@ponderosa/core";
import { Button, Chip } from "@mui/material";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ProviderStatusDialog } from "../src/components/ProviderStatusDialog";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: ReactNode }>(({ open, children }, ref) =>
      open ? createElement("div", { ref, role: "dialog" }, children) : null),
  };
});

const disabledEngine: EngineDto = {
  id: "claude",
  displayName: "Claude",
  models: [],
  efforts: [],
  configured: true,
  enabled: false,
  authenticated: true,
  available: false,
  availabilityDetail: "A previous access check failed.",
};

describe("provider status dialog", () => {
  it("renders an operator-disabled provider as inactive and withholds access testing", () => {
    const onTestAccess = vi.fn();
    const view = create(<ProviderStatusDialog
      open
      engines={[disabledEngine]}
      onTestAccess={onTestAccess}
      onOpenSettings={vi.fn()}
      onClose={vi.fn()}
    />);

    const labels = view.root.findAllByType(Chip).map((chip) => chip.props.label);
    expect(labels).toEqual(["Disabled", "Signed in", "Inactive"]);
    expect(JSON.stringify(view.toJSON())).toContain("Provider access is inactive while disabled by the operator.");
    expect(JSON.stringify(view.toJSON())).not.toContain("A previous access check failed.");
    expect(view.root.findAllByType(Button).filter((button) => button.props.children === "Test access")).toHaveLength(0);

    expect(onTestAccess).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps Test access for an enabled, signed-in provider whose runtime access failed", () => {
    const onTestAccess = vi.fn();
    const unavailable: EngineDto = { ...disabledEngine, enabled: true, displayName: "Codex" };
    const view = create(<ProviderStatusDialog
      open
      engines={[unavailable]}
      onTestAccess={onTestAccess}
      onOpenSettings={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(view.root.findAllByType(Chip).map((chip) => chip.props.label)).toEqual(["Enabled", "Signed in", "Needs attention"]);
    const testButton = view.root.findAllByType(Button).find((button) => button.props.children === "Test access")!;
    act(() => testButton.props.onClick());
    expect(onTestAccess).toHaveBeenCalledWith(unavailable);
    view.unmount();
  });
});
