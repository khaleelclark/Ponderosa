import { Box, useMediaQuery, useTheme } from "@mui/material";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ProviderQuotaIndicator } from "./ProviderUsageCenter";

type RegisterHeaderActionOutlet = (element: HTMLElement) => () => void;

const PrimaryHeaderActionsContext = createContext<
  RegisterHeaderActionOutlet | undefined
>(undefined);

/**
 * Owns the single global provider-usage observer above the route outlet. Route
 * headers register lightweight destinations, and the persistent control moves
 * between them without remounting its query or popover state.
 */
export function PrimaryHeaderActionsProvider({
  preferredProvider,
  onOpenProviderSettings,
  children,
  workspaceStatus,
}: {
  preferredProvider?: string;
  onOpenProviderSettings(): void;
  children: ReactNode;
  workspaceStatus?: ReactNode;
}): JSX.Element {
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down("sm"));
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const mobile = narrow || coarsePointer;
  const [fallbackOutlet, setFallbackOutlet] = useState<HTMLDivElement | null>(null);
  const [outlets, setOutlets] = useState<HTMLElement[]>([]);
  const register = useCallback<RegisterHeaderActionOutlet>((element) => {
    setOutlets(current => [...current.filter(candidate => candidate !== element), element]);
    return () => {
      setOutlets(current => current.filter(candidate => candidate !== element));
    };
  }, []);
  const value = useMemo(() => register, [register]);
  const activeOutlet = outlets.at(-1);

  return (
    <PrimaryHeaderActionsContext.Provider value={value}>
      <Box
        sx={{
          height: "100%",
          minHeight: 0,
          minWidth: 0,
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
      >
        <Box
          ref={setFallbackOutlet}
          data-primary-header-actions-fallback
          sx={{
            gridRow: 1,
            minHeight: { xs: 44, sm: 40 },
            px: { xs: 0.5, sm: 1.5 },
            display: activeOutlet ? "none" : "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            borderBottom: 1,
            borderColor: "divider",
          }}
        />
        <Box sx={{ gridRow: 2, minHeight: 0, minWidth: 0, display: "grid" }}>
          {children}
        </Box>
      </Box>
      {workspaceStatus && (activeOutlet ?? fallbackOutlet) ? createPortal(workspaceStatus, (activeOutlet ?? fallbackOutlet)!) : null}
      <ProviderQuotaIndicator
        preferredProvider={preferredProvider}
        mobile={mobile}
        portalTarget={activeOutlet ?? fallbackOutlet}
        onOpenProviderSettings={onOpenProviderSettings}
      />
    </PrimaryHeaderActionsContext.Provider>
  );
}

/** The trailing action destination shared by primary and utility headers. */
export function PrimaryHeaderActionsOutlet(): JSX.Element {
  const register = useContext(PrimaryHeaderActionsContext);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!element || !register) return;
    return register(element);
  }, [element, register]);

  return (
    <Box
      ref={setElement}
      data-primary-header-actions
      sx={{
        minWidth: 0,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
      }}
    />
  );
}
