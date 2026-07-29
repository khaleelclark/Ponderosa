import SearchIcon from "@mui/icons-material/Search";
import {
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
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { IconTitle } from "./IconTitle";
import { relativeTime } from "../agents";

export interface CollectionWorkspaceProps {
  title: string;
  detail?: string;
  icon?: ReactNode;
  scope?: ReactNode;
  primaryAction?: ReactNode;
  toolbar: ReactNode;
  children: ReactNode;
  listLabel: string;
  variant?: "page" | "embedded";
}

const CollectionAnnouncementContext = createContext<(message: string) => void>(
  () => undefined,
);

export function CollectionHeader({
  title,
  detail,
  icon,
  scope,
  primaryAction,
}: Pick<CollectionWorkspaceProps, "title" | "detail" | "icon" | "scope" | "primaryAction">): JSX.Element {
  return <Stack
    component="header"
    direction="row"
    spacing={1.5}
    sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: "flex-start", borderBottom: 1, borderColor: "divider" }}
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
          width: "auto",
          "& .MuiButton-root": {
            width: "auto",
            whiteSpace: "nowrap",
          },
        }}
      >
        {primaryAction}
      </Box>
    ) : null}
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
  toolbar,
  children,
  listLabel,
  variant = "page",
}: CollectionWorkspaceProps): JSX.Element {
  const embedded = variant === "embedded";
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  return <CollectionAnnouncementContext.Provider value={setReorderAnnouncement}>
    <Box
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
      {embedded ? null : <CollectionHeader title={title} detail={detail} icon={icon} scope={scope} primaryAction={primaryAction} />}
      {toolbar}
      <Stack
        className={embedded ? "ponderosa-scroll" : undefined}
        component="section"
        aria-label={listLabel}
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
          width: 1,
          height: 1,
          p: 0,
          m: -1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {reorderAnnouncement}
      </Box>
    </Box>
  </CollectionAnnouncementContext.Provider>;
}

export interface CollectionToolbarProps {
  search: string;
  onSearch(value: string): void;
  searchLabel: string;
  searchMaxWidth?: number;
  reorderHint?: boolean;
  children?: ReactNode;
}

export function CollectionToolbar({
  search,
  onSearch,
  searchLabel,
  searchMaxWidth,
  reorderHint = false,
  children,
}: CollectionToolbarProps): JSX.Element {
  return <Stack
    component="section"
    aria-label="Collection controls"
    direction={{ xs: "column", md: "row" }}
    spacing={1.25}
    useFlexGap
    flexWrap="wrap"
    sx={{ px: { xs: 2, md: 3 }, py: 1.5, alignItems: { md: "center" } }}
  >
    <TextField
      size="small"
      value={search}
      onChange={(event) => onSearch(event.target.value)}
      placeholder="Search"
      inputProps={{ "aria-label": searchLabel }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
      sx={{
        flex: searchMaxWidth ? "1 1 320px" : 1,
        minWidth: { md: 240 },
        maxWidth: searchMaxWidth ? { md: searchMaxWidth } : undefined,
      }}
    />
    {children ? (
      <Box
        sx={{
          display: { xs: "flex", md: "contents" },
          width: { xs: "100%", md: "auto" },
          minWidth: 0,
          gap: 1,
          alignItems: "center",
          flexWrap: "wrap",
          "& > .MuiFormControl-root": {
            width: { xs: "auto", md: undefined },
            minWidth: { xs: 140, md: undefined },
            flex: { xs: "1 1 140px", md: undefined },
          },
          "& > [data-collection-toolbar-actions]": {
            flex: { xs: "1 1 100%", md: undefined },
            justifyContent: { xs: "flex-start", md: undefined },
          },
        }}
      >
        {children}
      </Box>
    ) : null}
    {reorderHint ? (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ width: { xs: "100%", md: "auto" }, whiteSpace: "nowrap" }}
      >
        Reorder: Alt+Shift+↑/↓
      </Typography>
    ) : null}
  </Stack>;
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
          minWidth: compact ? 145 : 190,
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
        minWidth: compact ? 150 : 170,
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
        <Typography fontWeight={750} noWrap>{label}</Typography>
        {description ? <Typography component="div" variant="body2" color="text.secondary" noWrap>{description}</Typography> : null}
      </Box>
      {meta ? <Box sx={{ flexShrink: 0, minWidth: 0 }}>{meta}</Box> : null}
    </Box>
    {controls ? <Stack direction="row" spacing={0} sx={{ alignItems: "center", flexShrink: 0 }}>{controls}</Stack> : null}
    {starAction ? <Box sx={{ display: "grid", placeItems: "center", flexShrink: 0 }}>{starAction}</Box> : null}
    {overflowAction ? <Box sx={{ display: "grid", placeItems: "center", flexShrink: 0, pr: 0.5 }}>{overflowAction}</Box> : null}
  </Paper>;
}
