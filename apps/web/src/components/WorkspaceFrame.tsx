import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  Box,
  IconButton,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  useEffect,
  useSyncExternalStore,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { IconTitle } from "./IconTitle";

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

export interface TabbedWorkspaceFrameProps<T extends string> {
  icon: ReactElement;
  title: string;
  context?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  tabs: {
    activeLabel?: string;
    value: T | false;
    items: readonly WorkspaceTabItem<T>[];
    onChange(value: T): void;
    label: string;
  };
}

function WorkspaceTabBar<T extends string>({ value, items, onChange, label }: {
  value: T | false;
  items: readonly WorkspaceTabItem<T>[];
  onChange(value: T): void;
  label: string;
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
  const collapsed = useSyncExternalStore(
    subscribeHeaderCollapsed,
    readHeaderCollapsed,
    () => false,
  );
  const activeLabel =
    tabs.activeLabel ??
    tabs.items.find(item => item.value === tabs.value)?.label;
  const toggleCollapsed = () => writeHeaderCollapsed(!collapsed);

  return (
    <Box
      className="mobile-chat-chrome mobile-chat-header"
      sx={{
        minWidth: 0,
        bgcolor: "background.default",
        borderBottom: collapsed ? 1 : 0,
        borderColor: "divider",
      }}
    >
      <Box
        sx={{
          px: collapsed
            ? { xs: 1, sm: 1.5 }
            : { xs: 1.5, sm: 2, md: 2.5 },
          py: collapsed ? 0 : { xs: 1, sm: 1.25 },
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          flexWrap={collapsed ? "nowrap" : { xs: "wrap", sm: "nowrap" }}
          sx={{
            minHeight: collapsed ? { xs: 44, sm: 40 } : undefined,
            alignItems: collapsed
              ? "center"
              : { xs: "flex-start", sm: "center" },
            minWidth: 0,
          }}
        >
          <Box
            sx={
              collapsed
                ? {
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minWidth: 0,
                    flexGrow: 1,
                  }
                : {
                    minWidth: 0,
                    flexGrow: 1,
                    flexShrink: 1,
                    flexBasis: { xs: "auto", sm: 0 },
                  }
            }
          >
            {collapsed ? (
              <>
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
                  fontWeight={700}
                  noWrap
                  sx={{ minWidth: 0, flexShrink: 1 }}
                >
                  {title}
                </Typography>
                {activeLabel ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    sx={{ flexShrink: 0 }}
                  >
                    · {activeLabel}
                  </Typography>
                ) : null}
              </>
            ) : (
              <>
                <IconTitle icon={icon} title={title} component="h1" />
                {context ? (
                  <Box sx={{ mt: 0.15, minWidth: 0 }}>{context}</Box>
                ) : null}
                {meta ? (
                  <Box sx={{ mt: 0.15, minWidth: 0 }}>{meta}</Box>
                ) : null}
              </>
            )}
          </Box>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{
              alignItems: "center",
              justifyContent: "flex-end",
              flexWrap: "nowrap",
              flexShrink: 0,
            }}
          >
            {collapsed ? null : status}
            {collapsed ? null : actions}
            <Tooltip
              key="workspace-header-toggle"
              title={
                collapsed
                  ? "Expand workspace header"
                  : "Collapse workspace header"
              }
            >
              <IconButton
                size="small"
                aria-label={
                  collapsed
                    ? "Expand workspace header"
                    : "Collapse workspace header"
                }
                aria-expanded={!collapsed}
                onClick={toggleCollapsed}
                sx={{
                  flexShrink: 0,
                  width: { xs: 44, sm: 36 },
                  height: { xs: 44, sm: 36 },
                }}
              >
                {collapsed ? (
                  <KeyboardArrowDownIcon />
                ) : (
                  <KeyboardArrowUpIcon />
                )}
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Box>
      {collapsed ? null : <WorkspaceTabBar {...tabs} />}
    </Box>
  );
}
