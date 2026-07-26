// @vitest-environment node

import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ResourceContextMenu } from "../src/components/ResourceContextMenu";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  return {
    ...actual,
    Menu: ({
      children,
      open,
      MenuListProps,
    }: {
      children?: ReactNode;
      open: boolean;
      MenuListProps?: { "aria-label"?: string };
    }) => open ? <div role="menu" aria-label={MenuListProps?.["aria-label"]}>{children}</div> : null,
    MenuItem: ({
      children,
      disabled,
      onClick,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onClick?(): void;
    }) => <button type="button" disabled={disabled} onClick={onClick}>{children}</button>,
  };
});

describe("shared resource context menu", () => {
  it("opens a resource in a Ponderosa tab and closes the non-modal menu", () => {
    const onClose = vi.fn();
    const onOpenInNewTab = vi.fn();
    const resource = { kind: "project", projectId: "alpha" } as const;
    const view = create(<ResourceContextMenu
      state={{ anchor: {} as HTMLElement, resource }}
      onClose={onClose}
      onOpenInNewTab={onOpenInNewTab}
    />);

    expect(view.root.findByProps({ role: "menu" }).props["aria-label"]).toBe("Resource actions");
    const open = view.root.findByType("button");
    expect(JSON.stringify(view.toJSON())).toContain("Open in New Ponderosa Tab");
    act(() => open.props.onClick());
    expect(onOpenInNewTab).toHaveBeenCalledWith(resource);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("runs resource-specific actions through the same close contract", () => {
    const onClose = vi.fn();
    const onRename = vi.fn();
    const view = create(<ResourceContextMenu
      state={{ anchor: {} as HTMLElement, resource: "release" }}
      onClose={onClose}
      actions={[{ id: "rename", label: "Rename", onSelect: onRename }]}
    />);

    const items = view.root.findAllByType("button");
    expect(items[0]!.props.disabled).toBe(true);
    act(() => items[1]!.props.onClick());
    expect(onRename).toHaveBeenCalledWith("release");
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
  });
});
