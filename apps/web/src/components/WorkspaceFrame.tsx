import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  Box,
  IconButton,
  Stack,
  Tab,
  TabScrollButton,
  type TabScrollButtonProps,
  Tabs,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { IconTitle } from "./IconTitle";
import { workspaceHeaderSurfaceSx } from "../theme";
import { MobileNavigationButton } from "./MobileNavigationContext";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";

type WorkspaceTabItem<T extends string> = { value: T; label: string; icon?: ReactElement };

const WORKSPACE_HEADER_COLLAPSED_KEY = "ponderosa.workspace-header.collapsed.v1";
const workspaceHeaderListeners = new Set<() => void>();
let memoryHeaderCollapsed = false;

function readHeaderCollapsed(): boolean {
  try {
    if (typeof window === "undefined") return memoryHeaderCollapsed;
    const stored = window.localStorage.getItem(WORKSPACE_HEADER_COLLAPSED_KEY);
    return stored === null ? memoryHeaderCollapsed : stored === "true";
  } catch {
    return memoryHeaderCollapsed;
  }
}

function subscribeHeaderCollapsed(listener: () => void): () => void {
  workspaceHeaderListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== WORKSPACE_HEADER_COLLAPSED_KEY) return;
    memoryHeaderCollapsed = event.newValue === "true";
    listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    workspaceHeaderListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function writeHeaderCollapsed(collapsed: boolean): void {
  memoryHeaderCollapsed = collapsed;
  try {
    window.localStorage.setItem(
      WORKSPACE_HEADER_COLLAPSED_KEY,
      String(collapsed),
    );
  } catch {
    // The in-memory preference keeps controls usable without device storage.
  }
  workspaceHeaderListeners.forEach(listener => listener());
}

export function useWorkspaceHeaderCollapse(): {
  collapsed: boolean;
  toggleCollapsed(): void;
} {
  const mobile = useMediaQuery("(max-width: 899.95px)");
  const [mobileCollapsed, setMobileCollapsed] = useState(true);
  const collapsed = useSyncExternalStore(
    subscribeHeaderCollapsed,
    readHeaderCollapsed,
    () => false,
  );
  return {
    collapsed: mobile ? mobileCollapsed : collapsed,
    toggleCollapsed: () => mobile
      ? setMobileCollapsed(value => !value)
      : writeHeaderCollapsed(!collapsed),
  };
}

export interface TabbedWorkspaceFrameProps<T extends string> {
  icon: ReactElement;
  title: string;
  context?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  tabs: {
    idPrefix?: string;
    activeLabel?: string;
    value: T | false;
    items: readonly WorkspaceTabItem<T>[];
    onChange(value: T): void;
    label: string;
  };
}

function WorkspaceTabScrollButton(props: TabScrollButtonProps): JSX.Element {
  return <TabScrollButton {...props} role="button" tabIndex={props.disabled ? -1 : 0}
    aria-disabled={props.disabled || undefined}
    aria-label={props.direction === "left" ? "Scroll tabs left" : "Scroll tabs right"} />;
}

function WorkspaceTabBar<T extends string>({ value, items, onChange, label, idPrefix }: {
  value: T | false;
  items: readonly WorkspaceTabItem<T>[];
  onChange(value: T): void;
  label: string;
  idPrefix?: string;
}): JSX.Element {
  const [visualValue, setVisualValue] = useState<T | false>(value);
  useEffect(() => setVisualValue(value), [value]);
  const select = (next: T) => {
    // Keep the selection responsive without demoting the content switch.
    // Live output can continuously preempt a transition and leave the selected
    // tab showing stale content, so the owning workspace update stays urgent.
    setVisualValue(next);
    onChange(next);
  };
  return <Box sx={{ borderBottom: 1, borderColor: "divider", minWidth: 0 }}>
    <Tabs
      aria-label={label}
      value={visualValue}
      onChange={(_, next: T) => select(next)}
      variant="scrollable"
      scrollButtons="auto"
      allowScrollButtonsMobile
      slots={{ scrollButtons: WorkspaceTabScrollButton }}
      sx={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        minHeight: 48,
        "& .MuiTabs-scrollButtons": {
          width: { xs: 28, sm: 40 },
        },
      }}
    >
      {items.map((item) => <Tab
        key={item.value}
        id={idPrefix ? `${idPrefix}-${item.value}-tab` : undefined}
        aria-controls={idPrefix ? `${idPrefix}-${item.value}-panel` : undefined}
        value={item.value}
        icon={item.icon}
        iconPosition="start"
        label={item.label}
        sx={{
          minHeight: 48,
          minWidth: { xs: 88, sm: 112 },
          px: { xs: 1.25, sm: 2 },
        }}
      />)}
    </Tabs>
  </Box>;
}

export function CompactWorkspaceHeader({
  icon,
  title,
  context,
  action,
}: {
  icon: ReactElement;
  title: string;
  context?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <Box
      sx={theme => ({
        ...workspaceHeaderSurfaceSx(theme),
        minWidth: 0,
        containerType: "inline-size",
        borderBottom: 1,
        borderColor: "divider",
      })}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          minHeight: { xs: 44, sm: 40 },
          px: { xs: 1, sm: 1.5 },
          alignItems: "center",
          minWidth: 0,
        }}
      >
        <MobileNavigationButton />
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            minWidth: 0,
            flexGrow: 1,
          }}
        >
          <Box
            sx={{
              color: "text.secondary",
              display: "flex",
              flexShrink: 0,
            }}
          >
            {icon}
          </Box>
          <Typography
            variant="body2"
            component="h1"
            fontWeight={700}
            noWrap
            sx={{ minWidth: 0, flexShrink: 1 }}
          >
            {title}
          </Typography>
          {context ? (
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ flexShrink: 0, "@container (max-width: 640px)": { display: "none" } }}
            >
              · {context}
            </Typography>
          ) : null}
        </Box>
        <PrimaryHeaderActionsOutlet />
        {action}
      </Stack>
    </Box>
  );
}

/**
 * The owning identity-and-navigation chrome for Home, Create, Project, Chat and
 * Agent workplaces. Keeping both rows together prevents padded or duplicated
 * local tab bars from drifting away from the identity header.
 */
export function TabbedWorkspaceFrame<T extends string>({
  icon,
  title,
  context,
  meta,
  status,
  actions,
  tabs,
}: TabbedWorkspaceFrameProps<T>): JSX.Element {
  const { collapsed, toggleCollapsed } = useWorkspaceHeaderCollapse();
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const restoreToggleFocusRef = useRef(false);
  const activeLabel =
    tabs.activeLabel ??
    tabs.items.find(item => item.value === tabs.value)?.label;
  const handleToggleCollapsed = () => {
    restoreToggleFocusRef.current =
      document.activeElement === toggleButtonRef.current;
    toggleCollapsed();
  };
  useLayoutEffect(() => {
    if (!restoreToggleFocusRef.current) return;
    toggleButtonRef.current?.focus();
    restoreToggleFocusRef.current = false;
  }, [collapsed]);

  if (collapsed) {
    return (
      <CompactWorkspaceHeader
        icon={icon}
        title={title}
        context={activeLabel}
        action={(
          <Tooltip title="Expand workspace header">
            <IconButton
              ref={toggleButtonRef}
              size="small"
              aria-label="Expand workspace header"
              aria-expanded={false}
              onClick={handleToggleCollapsed}
              sx={{
                flexShrink: 0,
                width: { xs: 44, sm: 36 },
                height: { xs: 44, sm: 36 },
              }}
            >
              <KeyboardArrowDownIcon />
            </IconButton>
          </Tooltip>
        )}
      />
    );
  }

  return (
    <Box
      sx={theme => ({
        ...workspaceHeaderSurfaceSx(theme),
        minWidth: 0,
      })}
    >
      <Box sx={{ px: { xs: 1.5, sm: 2, md: 2.5 }, py: { xs: 0.5, md: 1 } }}>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "auto minmax(0, 1fr) auto", md: "auto minmax(0, 1fr) minmax(0, auto) auto" },
            alignItems: "center",
            columnGap: 1,
            rowGap: 0.25,
            minWidth: 0,
          }}
        >
          <MobileNavigationButton />
          <Box
            sx={{
              minWidth: 0,
              gridColumn: 2,
              gridRow: 1,
              overflow: "hidden",
            }}
          >
            <IconTitle icon={icon} title={title} component="h1" />
            {context ? <Box sx={{ mt: 0.15, minWidth: 0 }}>{context}</Box> : null}
            {meta ? <Box sx={{ mt: 0.15, minWidth: 0 }}>{meta}</Box> : null}
          </Box>
          <Stack
            direction="row"
            spacing={{ xs: 0.5, md: 1 }}
            useFlexGap
            sx={{
              alignItems: "center",
              justifyContent: "flex-end",
              flexWrap: "wrap",
              gridColumn: { xs: "1 / -1", md: 3 },
              gridRow: { xs: 2, md: 1 },
              minWidth: 0,
              maxWidth: "100%",
            }}
          >
            <PrimaryHeaderActionsOutlet />
            {status}
            {actions}
          </Stack>
          <Tooltip title="Collapse workspace header">
            <IconButton
              ref={toggleButtonRef}
              size="small"
              aria-label="Collapse workspace header"
              aria-expanded
              onClick={handleToggleCollapsed}
              sx={{
                flexShrink: 0,
                gridColumn: { xs: 3, md: 4 },
                gridRow: 1,
                width: { xs: 44, sm: 36 },
                height: { xs: 44, sm: 36 },
              }}
            >
              <KeyboardArrowUpIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      <WorkspaceTabBar {...tabs} />
    </Box>
  );
}
