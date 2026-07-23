import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Menu, MenuItem } from "@mui/material";
import type { ReactNode } from "react";

export interface ResourceContextMenuState<T> {
  anchor: HTMLElement;
  resource: T;
}

export interface ResourceContextMenuAction<T> {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  color?: "inherit" | "error";
  onSelect(resource: T): void;
}

/**
 * Shared, non-modal menu for repeated resource actions. Opening a Ponderosa tab
 * delegates its foreground/background disposition to the workspace owner.
 */
export function ResourceContextMenu<T>({
  state,
  onClose,
  onOpenInNewTab,
  actions = [],
}: {
  state?: ResourceContextMenuState<T>;
  onClose(): void;
  onOpenInNewTab?(resource: T): void;
  actions?: readonly ResourceContextMenuAction<T>[];
}): JSX.Element | null {
  if (!state) return null;
  const select = (action: (resource: T) => void) => {
    action(state.resource);
    onClose();
  };
  return <Menu
    anchorEl={state.anchor}
    open
    onClose={onClose}
    MenuListProps={{ "aria-label": "Resource actions" }}
  >
    <MenuItem disabled={!onOpenInNewTab} onClick={() => onOpenInNewTab && select(onOpenInNewTab)}>
      <OpenInNewIcon fontSize="small" sx={{ mr: 1 }} />
      Open in New Ponderosa Tab
    </MenuItem>
    {actions.map((action) => <MenuItem
      key={action.id}
      disabled={action.disabled}
      sx={action.color === "error" ? { color: "error.main" } : undefined}
      onClick={() => select(action.onSelect)}
    >
      {action.icon ? <span style={{ display: "inline-flex", marginRight: 8 }}>{action.icon}</span> : null}
      {action.label}
    </MenuItem>)}
  </Menu>;
}
