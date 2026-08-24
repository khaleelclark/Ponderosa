import { Box, useMediaQuery, useTheme } from "@mui/material";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
}: {
  preferredProvider?: string;
  onOpenProviderSettings(): void;
  children: ReactNode;
}): JSX.Element {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
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
      {children}
      <ProviderQuotaIndicator
        preferredProvider={preferredProvider}
        mobile={mobile}
        portalTarget={activeOutlet ?? null}
        onOpenProviderSettings={onOpenProviderSettings}
      />
    </PrimaryHeaderActionsContext.Provider>
  );
}

/** The trailing action destination shared by primary and utility headers. */
export function PrimaryHeaderActionsOutlet(): JSX.Element {
  const register = useContext(PrimaryHeaderActionsContext);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
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
