import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  Box,
  IconButton,
  Stack,
  Tab,
  TabScrollButton,
  type TabScrollButtonProps,
  type TabProps,
  Tabs,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import {
  forwardRef,
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

type WorkspaceTabItem<T extends string> = { value: T; label: string; icon?: ReactElement; disabled?: boolean };

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
  /** Reuse the persistent usage owner through an owner-specific action menu. */
  primaryActions?: ReactNode;
  /** A collapsed owner may reuse shared controls through its own action menu. */
  collapsedActions?: ReactNode;
  /** Chat/Agent mobile chrome gives controls priority over title width. */
  compactMobile?: boolean;
  actionsInMobileTabs?: boolean;
  /** Retain the owning tabs as icons when the header is collapsed. */
  collapsedIconTabs?: boolean;
  /** Branch workflows retain a compact Run action and one collapsed row. */
  collapsedSingleRow?: boolean;
  /** Keep essential authoring controls reachable in the compact desktop header. */
  retainCollapsedActions?: boolean;
  /** Keep owner status beside identity, ahead of shared usage controls. */
  statusBeforePrimaryActions?: boolean;
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

// Tabs must clone selection/keyboard props onto the Tab itself, not onto Tooltip.
const WorkspaceIconTab = forwardRef<HTMLDivElement, TabProps>(function WorkspaceIconTab(props, ref) {
  const tab = <Tab {...props} ref={ref} />;
  return <Tooltip title={props["aria-label"]}>{props.disabled ? <span aria-disabled="true" style={{display:"inline-flex"}}>{tab}</span> : tab}</Tooltip>;
});

export function WorkspaceTabBar<T extends string>({ value, items, onChange, label, idPrefix, compact = false }: {
  value: T | false;
  items: readonly WorkspaceTabItem<T>[];
  onChange(value: T): void;
  label: string;
  idPrefix?: string;
  compact?: boolean;
}): JSX.Element {
  const TabComponent = compact ? WorkspaceIconTab : Tab;
  return <Box sx={{ borderBottom: compact ? 0 : 1, borderColor: "divider", minWidth: compact ? 44 : 0, ...(compact ? {maxWidth:176} : {}) }}>
    <Tabs
      aria-label={label}
      value={value}
      onChange={(_, next: T) => onChange(next)}
      variant="scrollable"
      scrollButtons={compact ? false : "auto"}
      allowScrollButtonsMobile
      slots={{ scrollButtons: WorkspaceTabScrollButton }}
      sx={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        minHeight: compact ? 44 : 48,
        "& .MuiTabs-scrollButtons": {
          width: { xs: 28, sm: 40 },
        },
      }}
    >
      {items.map((item) => <TabComponent
        key={item.value}
        id={idPrefix ? `${idPrefix}-${item.value}-tab` : undefined}
        aria-controls={idPrefix ? `${idPrefix}-${item.value}-panel` : undefined}
        value={item.value}
        disabled={item.disabled}
        icon={item.icon}
        iconPosition="start"
        label={compact ? undefined : item.label}
        aria-label={compact ? item.label : undefined}
        sx={{
          minHeight: compact ? 44 : 48,
          minWidth: compact ? 44 : { xs: 88, sm: 112 },
          px: compact ? 0 : { xs: 1.25, sm: 2 },
          ...(compact ? { py: 0 } : {}),
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
  hideIcon = false,
  status,
  tabs,
  collapseAction,
  primaryActions,
  singleRow = false,
}: {
  icon: ReactElement;
  title: string;
  context?: ReactNode;
  action?: ReactNode;
  hideIcon?: boolean;
  status?: ReactNode;
  tabs?: ReactNode;
  collapseAction?: ReactNode;
  primaryActions?: ReactNode;
  singleRow?: boolean;
}): JSX.Element {
  const primary = primaryActions === undefined ? <PrimaryHeaderActionsOutlet /> : primaryActions;
  return (
    <Box
      data-workspace-header
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
        spacing={tabs ? 0 : 1}
        sx={{
          minHeight: { xs: 44, sm: 40 },
          px: { xs: 1, sm: 1.5 },
          alignItems: "center",
          minWidth: 0,
          ...(tabs ? {
            display:"grid",columnGap:.5,rowGap:0,
            gridTemplateAreas:'"identity tabs primary actions toggle"',
            gridTemplateColumns:"minmax(0, 1fr) minmax(44px, 176px) auto auto auto",
            "@container (max-width: 40rem)":singleRow?{
              gridTemplateColumns:"minmax(0, 1fr) 44px auto auto auto",
              columnGap:.25,
            }:{
              gridTemplateAreas:'"identity identity identity toggle" "tabs primary actions actions"',
              gridTemplateColumns:"minmax(44px, 1fr) auto auto auto",
            },
          } : status ? {"@container (max-width: 27.5rem)":{flexWrap:"wrap",justifyContent:"flex-end",rowGap:0}} : {}),
        }}
      >
        {tabs ? null : <MobileNavigationButton />}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            minWidth: 0,
            flexGrow: 1,
            ...(tabs ? {gridArea:"identity"} : status ? {"@container (max-width: 27.5rem)":{flexBasis:"calc(100% - 52px)"}} : {}),
            ...(singleRow?{"@container (max-width: 40rem)":{gap:.25}}:{}),
          }}
        >
          {tabs ? <MobileNavigationButton /> : null}
          <Box
            sx={{
              color: "text.secondary",
              display: hideIcon ? "none" : "flex",
              flexShrink: 0,
              ...(singleRow?{"@container (max-width: 40rem)":{display:"none"}}:{}),
            }}
          >
            {icon}
          </Box>
          <Typography
            variant="body2"
            component="h1"
            title={title}
            fontWeight={700}
            noWrap
            sx={{ minWidth: 0, flexShrink: 1 }}
          >
            {title}
          </Typography>
          {status}
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
        {tabs ? <>
          <Box sx={{gridArea:"tabs",minWidth:0}}>{tabs}</Box>
          <Box sx={{gridArea:"primary",display:"flex"}}>{primary}</Box>
          <Box sx={{gridArea:"actions",display:"flex",justifyContent:"flex-end"}}>{action}</Box>
          <Box sx={{gridArea:"toggle",justifySelf:"end"}}>{collapseAction}</Box>
        </> : <>{primary}{action}</>}
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
  primaryActions,
  collapsedActions,
  compactMobile = false,
  actionsInMobileTabs = false,
  collapsedIconTabs = false,
  collapsedSingleRow = false,
  retainCollapsedActions = false,
  statusBeforePrimaryActions = false,
  tabs,
}: TabbedWorkspaceFrameProps<T>): JSX.Element {
  const { collapsed, toggleCollapsed } = useWorkspaceHeaderCollapse();
  const mobile = useMediaQuery("(max-width: 899.95px)");
  const compact = compactMobile && mobile;
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const restoreToggleFocusRef = useRef(false);
  const activeLabel =
    tabs.activeLabel ??
    tabs.items.find(item => item.value === tabs.value)?.label;
  const identity = compact || statusBeforePrimaryActions ? <Typography component="h1" variant="body2" fontWeight={800} noWrap title={title}>{title}</Typography> : <IconTitle icon={icon} title={title} component="h1" />;
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
    const toggle = <Tooltip title="Expand workspace header">
      <IconButton ref={toggleButtonRef} size="small" aria-label="Expand workspace header"
        aria-expanded={false} onClick={handleToggleCollapsed}
        sx={{flexShrink:0,width:{xs:44,sm:36},height:{xs:44,sm:36}}}>
        <KeyboardArrowDownIcon />
      </IconButton>
    </Tooltip>;
    const retainedActions = collapsedActions !== undefined || compact || retainCollapsedActions ? <Stack direction="row" spacing={0.25} sx={{alignItems:"center",flexShrink:0}}>
      {statusBeforePrimaryActions ? null : status}{actionsInMobileTabs ? null : collapsedActions === undefined ? actions : collapsedActions}
    </Stack> : null;
    return <CompactWorkspaceHeader icon={icon} title={title} hideIcon={compact} singleRow={collapsedSingleRow}
      status={statusBeforePrimaryActions ? status : undefined}
      context={collapsedIconTabs ? undefined : activeLabel}
      tabs={collapsedIconTabs ? <WorkspaceTabBar {...tabs} compact /> : undefined}
      primaryActions={collapsedActions === undefined ? primaryActions : null}
      collapseAction={collapsedIconTabs ? toggle : undefined}
      action={collapsedIconTabs ? retainedActions : <>{retainedActions}{toggle}</>}
    />;
  }

  return (
    <Box
      data-workspace-header
      sx={theme => ({
        ...workspaceHeaderSurfaceSx(theme),
        minWidth: 0,
        ...(collapsedIconTabs ? {containerType:"inline-size"} : {}),
      })}
    >
      <Box sx={{ px: { xs: 1.5, sm: 2, md: 2.5 }, py: { xs: 0.5, md: 1 }, ...(statusBeforePrimaryActions ? {"@container (max-width: 40rem)":{px:1.5,py:.5}} : {}) }}>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: compact || statusBeforePrimaryActions ? "auto minmax(0, 1fr) auto auto" : "auto minmax(0, 1fr) auto", md: "auto minmax(0, 1fr) minmax(0, auto) auto" },
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
              overflow: statusBeforePrimaryActions ? "visible" : "hidden",
            }}
          >
            {statusBeforePrimaryActions ? <Box sx={{display:"flex",alignItems:"center",gap:1,minWidth:0}}><Box sx={{minWidth:0}}>{identity}</Box>{status}</Box> : identity}
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
              flexWrap: compact || statusBeforePrimaryActions ? "nowrap" : "wrap",
              gridColumn: { xs: compact || statusBeforePrimaryActions ? 3 : "1 / -1", md: 3 },
              gridRow: { xs: compact || statusBeforePrimaryActions ? 1 : 2, md: 1 },
              minWidth: 0,
              maxWidth: "100%",
            }}
          >
            {primaryActions === undefined ? <PrimaryHeaderActionsOutlet /> : primaryActions}
            {statusBeforePrimaryActions ? null : status}
            {compact && actionsInMobileTabs ? null : actions}
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
                gridColumn: { xs: compact || statusBeforePrimaryActions ? 4 : 3, md: 4 },
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
      <Box sx={{ display: "flex", alignItems: "center", minWidth: 0, borderBottom: 1, borderColor: "divider" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}><WorkspaceTabBar {...tabs} /></Box>
        {compact && actionsInMobileTabs ? <Box sx={{ flexShrink: 0 }}>{actions}</Box> : null}
      </Box>
    </Box>
  );
}
