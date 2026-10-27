import MenuIcon from "@mui/icons-material/Menu";
import { IconButton, Tooltip } from "@mui/material";
import { createContext, useContext, type ReactNode, type Ref } from "react";

const MobileNavigationContext = createContext<{
  onOpen(): void;
  desktopVisible: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
} | undefined>(undefined);

export function MobileNavigationProvider({
  onOpen,
  desktopVisible = false,
  buttonRef,
  children,
}: {
  onOpen(): void;
  desktopVisible?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}): JSX.Element {
  return (
    <MobileNavigationContext.Provider value={{ onOpen, desktopVisible, buttonRef }}>
      {children}
    </MobileNavigationContext.Provider>
  );
}

export function MobileNavigationButton(): JSX.Element | null {
  const navigation = useContext(MobileNavigationContext);
  if (!navigation) return null;
  return (
    <Tooltip title="Open navigation">
      <IconButton
        ref={navigation.buttonRef}
        aria-label="Open workspace navigation"
        onClick={navigation.onOpen}
        sx={{
          display: { xs: "inline-flex", md: navigation.desktopVisible ? "inline-flex" : "none" },
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
