import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Menu, MenuItem } from "@mui/material";
import { type ReactNode, useEffect, useRef } from "react";

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
  const menuListRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!state) return;
    const dismissOutside = (event: PointerEvent) => {
      if (menuListRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () =>
      document.removeEventListener("pointerdown", dismissOutside, true);
  }, [state, onClose]);

  if (!state) return null;
  const select = (action: (resource: T) => void) => {
    action(state.resource);
    onClose();
  };
  return <Menu
    anchorEl={state.anchor}
    open
    onClose={onClose}
    disableEnforceFocus
    disableRestoreFocus
    MenuListProps={{
      "aria-label": "Resource actions",
      ref: menuListRef,
    }}
    sx={{
      pointerEvents: "none",
      "& .MuiBackdrop-root": { pointerEvents: "none" },
      "& .MuiPaper-root": { pointerEvents: "auto" },
    }}
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
