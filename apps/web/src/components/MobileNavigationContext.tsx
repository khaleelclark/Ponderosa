import MenuIcon from "@mui/icons-material/Menu";
import { IconButton, Tooltip } from "@mui/material";
import { createContext, useContext, type ReactNode } from "react";

const MobileNavigationContext = createContext<(() => void) | undefined>(
  undefined,
);

export function MobileNavigationProvider({
  onOpen,
  children,
}: {
  onOpen(): void;
  children: ReactNode;
}): JSX.Element {
  return (
    <MobileNavigationContext.Provider value={onOpen}>
      {children}
    </MobileNavigationContext.Provider>
  );
}

export function MobileNavigationButton(): JSX.Element | null {
  const onOpen = useContext(MobileNavigationContext);
  if (!onOpen) return null;
  return (
    <Tooltip title="Open navigation">
      <IconButton
        aria-label="Open workspace navigation"
        onClick={onOpen}
        sx={{
          display: { xs: "inline-flex", md: "none" },
          width: 40,
          height: 40,
          ml: -0.5,
          flex: "0 0 auto",
        }}
      >
        <MenuIcon />
      </IconButton>
    </Tooltip>
  );
}
