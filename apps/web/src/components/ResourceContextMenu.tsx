import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { MenuItem, MenuList, Paper, Popper } from "@mui/material";
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
  const skipFocusRestoreRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!state) return;
    skipFocusRestoreRef.current = false;
    const focusMenu = window.requestAnimationFrame(() =>
      menuListRef.current?.focus(),
    );
    const dismissOutside = (event: PointerEvent) => {
      if (menuListRef.current?.contains(event.target as Node)) return;
      const target = event.target instanceof Element ? event.target : undefined;
      const switchingMenus = Boolean(
        target?.closest("[data-resource-menu-trigger]"),
      );
      if (
        event.button === 2 ||
        (event.button === 0 && event.ctrlKey) ||
        switchingMenus
      ) {
        skipFocusRestoreRef.current = true;
      } else if (event.button === 0) {
        // Match native menu behavior: the first ordinary left-click dismisses
        // the menu without also activating content behind it.
        event.preventDefault();
        event.stopPropagation();
        const swallowClick = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        };
        document.addEventListener("click", swallowClick, {
          capture: true,
          once: true,
        });
        window.setTimeout(
          () => document.removeEventListener("click", swallowClick, true),
          0,
        );
      }
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => {
      window.cancelAnimationFrame(focusMenu);
      document.removeEventListener("pointerdown", dismissOutside, true);
      if (!skipFocusRestoreRef.current && state.anchor.isConnected) {
        window.requestAnimationFrame(() => state.anchor.focus());
      }
    };
  }, [state]);

  if (!state) return null;
  const select = (action: (resource: T) => void) => {
    action(state.resource);
    onClose();
  };
  return <Popper
    anchorEl={state.anchor}
    open
    placement="bottom-end"
    sx={{ zIndex: theme => theme.zIndex.modal }}
  >
    <Paper elevation={8}>
      <MenuList
        ref={menuListRef}
        tabIndex={-1}
        aria-label="Resource actions"
        onKeyDown={event => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onCloseRef.current();
        }}
      >
        {onOpenInNewTab ? <MenuItem onClick={() => select(onOpenInNewTab)}>
          <OpenInNewIcon fontSize="small" sx={{ mr: 1 }} />
          Open in New Ponderosa Tab
        </MenuItem> : null}
        {actions.map((action) => <MenuItem
          key={action.id}
          disabled={action.disabled}
          sx={action.color === "error" ? { color: "error.main" } : undefined}
          onClick={() => select(action.onSelect)}
        >
          {action.icon ? <span style={{ display: "inline-flex", marginRight: 8 }}>{action.icon}</span> : null}
          {action.label}
        </MenuItem>)}
      </MenuList>
    </Paper>
  </Popper>;
}
