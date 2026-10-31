import { Box, useMediaQuery, useTheme } from "@mui/material";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import { ProviderQuotaIndicator } from "./ProviderUsageCenter";

type HeaderActionTrigger = ComponentProps<typeof ProviderQuotaIndicator>["renderTrigger"];
type RegisterHeaderActionOutlet = (element: HTMLElement, depth?: number, renderTrigger?: HeaderActionTrigger) => () => void;
type HeaderActionOutlet = { element: HTMLElement; depth: number; renderTrigger?: HeaderActionTrigger };

const PrimaryHeaderActionsContext = createContext<
  {register: RegisterHeaderActionOutlet; activeOutlet?: HTMLElement} | undefined
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
  const [outlets, setOutlets] = useState<HeaderActionOutlet[]>([]);
  const register = useCallback<RegisterHeaderActionOutlet>((element, depth = 0, renderTrigger) => {
    setOutlets(current => [...current.filter(candidate => candidate.element !== element), { element, depth, renderTrigger }]);
    return () => {
      setOutlets(current => current.filter(candidate => candidate.element !== element));
    };
  }, []);
  // Scoped Chat/Agent chrome outranks its Branch even when the outer header remounts.
  const activeRegistration = outlets.reduce<HeaderActionOutlet | undefined>((active, next) => !active || next.depth >= active.depth ? next : active, undefined);
  const activeOutlet = activeRegistration?.element;
  const value = useMemo(() => ({register, activeOutlet}), [register, activeOutlet]);

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
        renderTrigger={activeRegistration?.renderTrigger}
        preferredProvider={preferredProvider}
        mobile={mobile}
        portalTarget={activeOutlet ?? fallbackOutlet}
        onOpenProviderSettings={onOpenProviderSettings}
      />
    </PrimaryHeaderActionsContext.Provider>
  );
}

/** Keep shared usage in the deepest mounted Chat/Agent header, with outer fallback. */
export function PrimaryHeaderActionsScope({children}:{children:ReactNode}):JSX.Element {
  const owner=useContext(PrimaryHeaderActionsContext);
  const register=owner?.register;
  const scopedRegister=useCallback<RegisterHeaderActionOutlet>((element,depth=0,renderTrigger)=>{
    const unregister=register?.(element,depth+1,renderTrigger);
    return ()=>unregister?.();
  },[register]);
  const value=useMemo(()=>({register:scopedRegister,activeOutlet:owner?.activeOutlet}),[scopedRegister,owner?.activeOutlet]);
  return <PrimaryHeaderActionsContext.Provider value={value}>{children}</PrimaryHeaderActionsContext.Provider>;
}

/** The trailing action destination shared by primary and utility headers. */
export function PrimaryHeaderActionsOutlet({renderTrigger, fallback}: {renderTrigger?: HeaderActionTrigger; fallback?: ReactNode} = {}): JSX.Element {
  const owner = useContext(PrimaryHeaderActionsContext);
  const register = owner?.register;
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!element || !register) return;
    return register(element, 0, renderTrigger);
  }, [element, register, renderTrigger]);

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
    >
      {owner?.activeOutlet === element ? null : fallback}
    </Box>
  );
}
