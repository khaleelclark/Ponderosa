import { Box } from "@mui/material";
import type { KeyboardEvent, ReactNode } from "react";

/**
 * The single non-scrolling grid row that owns chat composition chrome. The
 * surrounding chat surface scrolls; this dock never competes with it through
 * fixed, sticky, or scroll-triggered visibility state.
 */
export function ChatComposerDock({
  children,
  visible = true,
  onKeyDown,
}: {
  children: ReactNode;
  visible?: boolean;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
}): JSX.Element {
  return (
    <Box
      hidden={!visible}
      onKeyDown={onKeyDown}
      sx={{
        display: visible ? "block" : "none",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        bgcolor: "transparent",
      }}
    >
      {children}
    </Box>
  );
}
