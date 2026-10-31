import SearchIcon from "@mui/icons-material/Search";
import {
  Alert,
  Box,
  Button,
  FormControl,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ProjectDto, ProjectSort } from "@ponderosa/core";
import type { WorkspaceDirectoryRequestState } from "../hooks/useWorkspaceDirectory";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { IconTitle } from "./IconTitle";
import { relativeTime } from "../agents";
import { useInfiniteScrollSentinel } from "../hooks/useInfiniteScrollSentinel";
import { LoadingState } from "./LoadingState";
import { MobileNavigationButton } from "./MobileNavigationContext";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";

export interface CollectionWorkspaceProps {
  title: string;
  detail?: string;
  icon?: ReactNode;
  scope?: ReactNode;
  primaryAction?: ReactNode;
  compactPrimaryAction?: ReactNode;
  toolbar: ReactNode;
  children: ReactNode;
  listLabel: string;
  variant?: "page" | "embedded";
  busy?: boolean;
}

const CollectionAnnouncementContext = createContext<(message: string) => void>(
  () => undefined,
);
const CollectionCompactContext = createContext(false);

export const COLLECTION_PROGRESSIVE_BATCH_SIZE = 25;

/**
 * Display-only progressive disclosure for already-loaded collections. Search,
 * sorting, hierarchy context, and selection continue to operate on `items`;
 * only the rows mounted in the DOM are bounded.
 */
export function useProgressiveItems<T>(
  items: readonly T[],
  options: { batchSize?: number; resetKey?: string } = {},
): {
  visibleItems: readonly T[];
  visibleCount: number;
  remainingCount: number;
  hasMore: boolean;
  showMore(): void;
} {
  const { batchSize, resetKey } = options;
  const [limit, setLimit] = useState(
    batchSize ?? COLLECTION_PROGRESSIVE_BATCH_SIZE,
  );
  useEffect(() => {
    if (batchSize !== undefined) setLimit(batchSize);
  }, [batchSize, resetKey]);
  const visibleCount = batchSize === undefined
    ? items.length
    : Math.min(limit, items.length);
  return {
    visibleItems: items.slice(0, visibleCount),
    visibleCount,
    remainingCount: items.length - visibleCount,
    hasMore: visibleCount < items.length,
    showMore: () => {
      if (batchSize !== undefined)
        setLimit(current => current + batchSize);
    },
  };
}

export function CollectionProgressiveFooter({
  visibleCount,
  totalCount,
  batchSize = COLLECTION_PROGRESSIVE_BATCH_SIZE,
  resourceLabel,
  onShowMore,
}: {
  visibleCount: number;
  totalCount: number;
  batchSize?: number;
  resourceLabel: string;
  onShowMore(): void;
}): JSX.Element | null {
  const remaining = Math.max(0, totalCount - visibleCount);
  if (!remaining) return null;
  const nextCount = Math.min(batchSize, remaining);
  return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
      <Button size="small" color="inherit" onClick={onShowMore}>
        {`Show ${nextCount} more ${resourceLabel} · ${remaining} remaining`}
      </Button>
    </Box>
  );
}

export function CollectionHeader({
  title,
  detail,
  icon,
  scope,
  primaryAction,
  compactPrimaryAction,
}: Pick<CollectionWorkspaceProps, "title" | "detail" | "icon" | "scope" | "primaryAction" | "compactPrimaryAction">): JSX.Element {
  const compact = useContext(CollectionCompactContext);
  if (compact) return <Stack component="header" direction="row" spacing={0.5} sx={{ px: 1, minHeight: 48, alignItems: "center", minWidth: 0, borderBottom: 1, borderColor: "divider" }}>
    <MobileNavigationButton />
    <Box sx={{ flex: 1, minWidth: 0 }} title={detail}>
      {icon ? <IconTitle icon={icon} title={title} component="h1" /> : <Typography variant="h6" component="h1" fontWeight={800} noWrap>{title}</Typography>}
    </Box>
    <PrimaryHeaderActionsOutlet />
    {compactPrimaryAction ?? primaryAction}
  </Stack>;
  return <Stack
    component="header"
    direction="row"
    spacing={1}
    sx={{ px: { xs: 1, md: 3 }, py: 2, alignItems: "flex-start", borderBottom: 1, borderColor: "divider" }}
  >
    <MobileNavigationButton />
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={1.5}
      sx={{ flex: 1, minWidth: 0, alignItems: { xs: "flex-start", sm: "center" } }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
          {icon ? <IconTitle icon={icon} title={title} component="h1" /> : <Typography variant="h6" component="h1" fontWeight={800}>{title}</Typography>}
          {scope}
        </Stack>
        {detail ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.15 }}>{detail}</Typography> : null}
      </Box>
      {primaryAction ? (
        <Box
          sx={{
            flexShrink: 0,
            width: { xs: "100%", sm: "auto" },
            display: "flex",
            justifyContent: "flex-start",
            "& .MuiButton-root": {
              width: "auto",
              whiteSpace: "nowrap",
            },
          }}
        >
          {primaryAction}
        </Box>
      ) : null}
    </Stack>
    <PrimaryHeaderActionsOutlet />
  </Stack>;
}

/**
 * The owning shell for the four directory workplaces. Header, controls and
 * list spacing live here so a directory cannot drift by reassembling them.
 */
export function CollectionWorkspace({
  title,
  detail,
  icon,
  scope,
  primaryAction,
  compactPrimaryAction,
  toolbar,
  children,
  listLabel,
  variant = "page",
  busy = false,
}: CollectionWorkspaceProps): JSX.Element {
  const embedded = variant === "embedded";
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth < 820);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0]) setCompact(entries[0].contentRect.width < 820);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return <CollectionAnnouncementContext.Provider value={setReorderAnnouncement}>
    <CollectionCompactContext.Provider value={compact}>
    <Box
      ref={rootRef}
      className={embedded ? undefined : "ponderosa-scroll"}
      sx={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: embedded ? "hidden" : undefined,
        overflowY: embedded ? undefined : "auto",
        overflowX: "hidden",
        display: embedded ? "grid" : undefined,
        gridTemplateRows: embedded ? "auto minmax(0, 1fr)" : undefined,
      }}
    >
      {embedded ? null : <CollectionHeader title={title} detail={detail} icon={icon} scope={scope} primaryAction={primaryAction} compactPrimaryAction={compactPrimaryAction} />}
      {toolbar}
      <Stack
        className={embedded ? "ponderosa-scroll" : undefined}
        component="section"
        aria-label={listLabel}
        aria-busy={busy}
        spacing={0.75}
        sx={{
          minHeight: 0,
          overflowY: embedded ? "auto" : undefined,
          overflowX: "hidden",
          px: { xs: 2, md: 3 },
          pb: embedded ? 2 : 3,
        }}
      >
        {children}
      </Stack>
      <Box
        aria-live="polite"
        aria-atomic="true"
        sx={{
          position: "absolute",
          width: "1px",
          height: "1px",
          p: 0,
          m: "-1px",
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {reorderAnnouncement}
      </Box>
    </Box>
    </CollectionCompactContext.Provider>
  </CollectionAnnouncementContext.Provider>;
}

export interface CollectionToolbarProps {
  search: string;
  onSearch(value: string): void;
  searchLabel: string;
  searchMaxWidth?: number;
  reorderHint?: boolean;
  compactControls?: ReactNode;
  children?: ReactNode;
}

export function CollectionToolbar({
  search,
  onSearch,
  searchLabel,
  searchMaxWidth,
  reorderHint = false,
  compactControls,
  children,
}: CollectionToolbarProps): JSX.Element {
  const compact = useContext(CollectionCompactContext);
  return <Box
    component="section"
    aria-label="Collection controls"
    sx={{
      px: compact ? 2 : { xs: 2, md: 3 },
      py: compact ? 1 : 1.5,
      display: "grid",
      gridTemplateColumns: compact ? "minmax(0, 1fr) auto" : "minmax(160px, 1fr) auto",
      alignItems: "center",
      gap: 1.25,
    }}
  >
    <TextField
      size="small"
      value={search}
      onChange={(event) => onSearch(event.target.value)}
      placeholder="Search"
      inputProps={{ "aria-label": searchLabel }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
      sx={{
        width: "100%",
        minWidth: 0,
        maxWidth: searchMaxWidth ? { lg: searchMaxWidth } : undefined,
      }}
    />
    {compact && compactControls ? <Box sx={{ flexShrink: 0 }}>{compactControls}</Box> : null}
    {children && (!compact || !compactControls) ? (
      <Box
        sx={theme => ({
          display: compact ? "grid" : "flex",
          gridColumn: compact ? "1 / -1" : undefined,
          gridTemplateColumns: {
            xs: "minmax(0, 1fr)",
            sm: "repeat(2, minmax(0, 1fr))",
            md: "repeat(3, minmax(0, 1fr))",
          },
          width: "100%",
          minWidth: 0,
          gap: 1,
          alignItems: "center",
          flexWrap: "nowrap",
          [theme.breakpoints.down("lg")]: {
            "& > .MuiFormControl-root": {
              width: "100%",
              minWidth: 0,
            },
            "& > [data-collection-toolbar-actions]": {
              gridColumn: "1 / -1",
              justifyContent: "flex-start",
            },
            "& > [role='group']": {
              width: "100%",
              justifyContent: "center",
            },
            "& > .MuiButton-root": {
              minWidth: 0,
            },
          },
        })}
      >
        {children}
      </Box>
    ) : null}
    {reorderHint && !compact ? (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ gridColumn: "1 / -1", whiteSpace: "nowrap", "@media (hover: none)": { display: "none" } }}
      >
        Reorder: Alt+Shift+↑/↓
      </Typography>
    ) : null}
  </Box>;
}

export function CollectionDirectoryControls({
  projects,
  projectId,
  onProject,
  sort,
  onSort,
  compact = false,
}: {
  projects?: ProjectDto[];
  projectId?: string;
  onProject?(value: string): void;
  sort: ProjectSort;
  onSort(value: ProjectSort): void;
  compact?: boolean;
}): JSX.Element {
  const controlId = useId();
  return <>
    {projects && onProject ? (
      <FormControl
        size="small"
        sx={{
          minWidth: compact ? 132 : 190,
          width: { xs: "100%", sm: "auto" },
        }}
      >
        <InputLabel id={`${controlId}-project`}>Project</InputLabel>
        <Select
          labelId={`${controlId}-project`}
          label="Project"
          value={projectId ?? ""}
          onChange={event => onProject(event.target.value)}
        >
          <MenuItem value="">All Projects</MenuItem>
          {projects.map(project => (
            <MenuItem key={project.id} value={project.id}>
              {project.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    ) : null}
    <FormControl
      size="small"
      sx={{
        minWidth: compact ? 138 : 170,
        width: { xs: "100%", sm: "auto" },
      }}
    >
      <InputLabel id={`${controlId}-sort`}>Sort</InputLabel>
      <Select
        labelId={`${controlId}-sort`}
        label="Sort"
        value={sort}
        onChange={event => onSort(event.target.value as ProjectSort)}
      >
        <MenuItem value="last_used">Recent Activity</MenuItem>
        <MenuItem value="alphabetical">Alphabetical</MenuItem>
        <MenuItem value="custom">Custom Order</MenuItem>
      </Select>
    </FormControl>
  </>;
}

export function CollectionEmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: { label: string; onClick(): void };
}): JSX.Element {
  return <Stack
    sx={{ py: 6, px: 2, alignItems: "center", textAlign: "center" }}
    spacing={0.5}
  >
    <Typography fontWeight={750}>{title}</Typography>
    {detail ? <Typography variant="body2" color="text.secondary">{detail}</Typography> : null}
    {action ? <Button size="small" onClick={action.onClick} sx={{ mt: 0.5 }}>{action.label}</Button> : null}
  </Stack>;
}

export function CollectionStateFeedback({
  request,
  itemCount,
  filtersActive,
  resourceLabel,
  emptyTitle,
  emptyDetail,
  noMatchTitle,
  noMatchDetail,
  onClearFilters,
  compact = false,
  suppressEmpty = false,
  autoLoadMore = true,
}: {
  request: WorkspaceDirectoryRequestState;
  itemCount: number;
  filtersActive: boolean;
  resourceLabel: string;
  emptyTitle: string;
  emptyDetail?: string;
  noMatchTitle?: string;
  noMatchDetail?: string;
  onClearFilters?(): void;
  compact?: boolean;
  suppressEmpty?: boolean;
  autoLoadMore?: boolean;
}): JSX.Element | null {
  if (request.isInitialLoading) {
    return <LoadingState resource={resourceLabel} variant={compact ? "inline" : "route"} />;
  }
  if (request.isInitialError) {
    return <Alert
      severity="error"
      action={<Button size="small" onClick={() => void request.retry()}>Retry</Button>}
      sx={{ my: compact ? 1 : 2 }}
    >
      {"Could not load " + resourceLabel + "."}
    </Alert>;
  }
  const empty =
    request.hasResolved && itemCount === 0 && !request.hasNextPage && !request.isPaginationError && !request.isRefreshError;
  return <>
    {request.isRefreshError ? <Alert severity="warning" action={<Button size="small" onClick={() => void request.retry()}>Retry</Button>} sx={{ my: 1 }}>
      {"Could not refresh " + resourceLabel + ". Existing results are still available."}
    </Alert> : null}
    {empty && !suppressEmpty ? <CollectionEmptyState
      title={filtersActive ? (noMatchTitle ?? "No matching " + resourceLabel) : emptyTitle}
      detail={filtersActive ? noMatchDetail : emptyDetail}
      action={filtersActive && onClearFilters ? { label: "Clear filters", onClick: onClearFilters } : undefined}
    /> : null}
    {!empty ? <CollectionPagination request={request} resourceLabel={resourceLabel} autoLoadMore={autoLoadMore} /> : null}
  </>;
}

export function CollectionPagination({
  request,
  resourceLabel,
  autoLoadMore = true,
}: {
  request: WorkspaceDirectoryRequestState;
  resourceLabel: string;
  autoLoadMore?: boolean;
}): JSX.Element | null {
  const sentinelRef = useInfiniteScrollSentinel({
    enabled: autoLoadMore && request.hasNextPage && !request.isPaginationError,
    loading: request.isFetchingNextPage,
    onLoadMore: request.fetchNextPage,
  });
  if (!request.hasNextPage && !request.isPaginationError) return null;
  if (request.isPaginationError) return <Alert
    severity="warning"
    action={<Button size="small" onClick={() => void request.fetchNextPage()}>Retry</Button>}
    sx={{ my: 1 }}
  >
    {"Could not load more " + resourceLabel + ". Existing results are still available."}
  </Alert>;
  return (
    <Stack ref={sentinelRef} sx={{ alignItems: "center", my: 1, minHeight: 32 }}>
      {request.isFetchingNextPage ? (
        <LoadingState resource={`more ${resourceLabel}`} variant="inline" />
      ) : (
        <Button size="small" onClick={() => void request.fetchNextPage()}>
          {"Load more " + resourceLabel}
        </Button>
      )}
    </Stack>
  );
}
/**
 * Shared directory timestamp treatment. Relative time is easier to scan across
 * mixed resources, while the tooltip preserves the exact local timestamp.
 */
export function CollectionTimestamp({
  value,
  hideBelow = "sm",
}: {
  value?: string;
  hideBelow?: "sm" | "md" | "lg" | false;
}): JSX.Element | null {
  if (!value) return null;
  const label = relativeTime(value);
  if (!label) return null;
  return (
    <Tooltip title={new Date(value).toLocaleString()}>
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        component="time"
        dateTime={value}
        sx={{
          display: hideBelow ? { xs: "none", [hideBelow]: "block" } : "block",
          minWidth: 72,
          textAlign: "right",
        }}
      >
        {label}
      </Typography>
    </Tooltip>
  );
}

export interface ResourceRowProps {
  label: string;
  description?: ReactNode;
  leading?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  controls?: ReactNode;
  starAction?: ReactNode;
  overflowAction?: ReactNode;
  onOpen(): void;
  onContextMenu?(anchor: HTMLElement): void;
  draggable?: boolean;
  onDragStart?(event: DragEvent<HTMLElement>): void;
  onDragEnd?(): void;
  onDragOver?(event: DragEvent<HTMLElement>): void;
  onDrop?(event: DragEvent<HTMLElement>): void;
  onKeyboardMove?(
    direction: "up" | "down",
  ): false | { position: number; total: number };
  highlighted?: boolean;
  resourceIdentity?: string;
}

export function ResourceRow({
  label,
  description,
  leading,
  icon,
  meta,
  controls,
  starAction,
  overflowAction,
  onOpen,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onKeyboardMove,
  highlighted = false,
  resourceIdentity,
}: ResourceRowProps): JSX.Element {
  const dragPreviewRef = useRef<HTMLElement>();
  const openTargetRef = useRef<HTMLDivElement>(null);
  const announceCollectionChange = useContext(CollectionAnnouncementContext);
  const clearDragPreview = () => {
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = undefined;
  };
  const createDragPreview = (event: DragEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    clearDragPreview();
    const preview = document.createElement("div");
    const content = event.currentTarget.firstElementChild?.cloneNode(true);
    const rowStyles = window.getComputedStyle(event.currentTarget);
    preview.setAttribute("aria-hidden", "true");
    Object.assign(preview.style, {
      position: "fixed",
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      zIndex: "2147483647",
      boxSizing: "border-box",
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      display: "flex",
      overflow: "hidden",
      pointerEvents: "none",
      background: rowStyles.background,
      border: rowStyles.border,
      borderRadius: rowStyles.borderRadius,
      boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
    });
    if (content instanceof HTMLElement) {
      content.removeAttribute("role");
      content.removeAttribute("tabindex");
      content.removeAttribute("aria-label");
      content.style.width = "100%";
      content.style.pointerEvents = "none";
      preview.appendChild(content);
    }
    document.body.appendChild(preview);
    dragPreviewRef.current = preview;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", label);
    event.dataTransfer.setDragImage(
      preview,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  };
  return <Paper
    variant="outlined"
    draggable={draggable}
    onDragStart={(event) => {
      createDragPreview(event);
      onDragStart?.(event);
    }}
    onDragEnd={() => {
      clearDragPreview();
      onDragEnd?.();
    }}
    onDragOver={(event) => {
      if (!onDrop && !onDragOver) return;
      event.preventDefault();
      onDragOver?.(event);
    }}
    onDrop={(event) => {
      if (!onDrop) return;
      event.preventDefault();
      onDrop(event);
    }}
    onContextMenu={(event) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu(openTargetRef.current ?? event.currentTarget);
    }}
    sx={{
      position: "relative",
      display: "flex",
      alignItems: "stretch",
      overflow: "hidden",
      borderColor: highlighted ? "primary.main" : undefined,
      bgcolor: highlighted ? "action.hover" : undefined,
      transform: highlighted ? "translateY(1px)" : "none",
      transition: "border-color 120ms ease, background-color 120ms ease, transform 120ms ease",
    }}
  >
    <Box
      ref={openTargetRef}
      component="div"
      role="button"
      tabIndex={0}
      aria-label={`Open ${label}`}
      data-resource-id={resourceIdentity}
      aria-keyshortcuts={
        onKeyboardMove
          ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
          : undefined
      }
      onClick={onOpen}
      onKeyDown={(event) => {
        if (
          onKeyboardMove &&
          event.altKey &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          event.stopPropagation();
          const direction = event.key === "ArrowUp" ? "up" : "down";
          const result = onKeyboardMove(direction);
          if (result) {
            announceCollectionChange(
              `${label} moved to position ${result.position} of ${result.total}`,
            );
            const row = event.currentTarget;
            window.requestAnimationFrame(() =>
              row.scrollIntoView({ block: "nearest" }),
            );
          }
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      sx={{
        border: 0,
        bgcolor: "transparent",
        color: "inherit",
        font: "inherit",
        minWidth: 0,
        flex: 1,
        px: 1.5,
        py: 1.25,
        display: "flex",
        alignItems: "center",
        textAlign: "left",
        cursor: "pointer",
        gap: 1.25,
        "&:hover": { bgcolor: "action.hover" },
        "&:focus-visible": { outline: "2px solid var(--ponderosa-focus-ring)", outlineOffset: -2 },
      }}
    >
      {leading}
      {icon ? <Box sx={{ width: 38, height: 38, flex: "0 0 auto", borderRadius: 1.5, bgcolor: "action.selected", display: "grid", placeItems: "center", color: "primary.main", "& > svg": { fontSize: 21 } }}>{icon}</Box> : null}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography fontWeight={750} noWrap sx={{display:{xs:"-webkit-box",sm:"block"},WebkitLineClamp:2,WebkitBoxOrient:"vertical",whiteSpace:{xs:"normal",sm:"nowrap"},overflowWrap:"anywhere"}}>{label}</Typography>
        {description ? <Typography component="div" variant="body2" color="text.secondary" noWrap>{description}</Typography> : null}
      </Box>
      {meta ? <Box sx={{ flexShrink: 0, minWidth: 0 }}>{meta}</Box> : null}
    </Box>
    {controls ? <Stack direction="row" spacing={0} sx={{ alignItems: "center", flexShrink: 0 }}>{controls}</Stack> : null}
    {starAction ? <Box sx={{ display: "grid", placeItems: "center", flexShrink: 0 }}>{starAction}</Box> : null}
    {overflowAction ? <Box sx={{ display: "grid", placeItems: "center", flexShrink: 0, pr: 0.5 }}>{overflowAction}</Box> : null}
  </Paper>;
}
