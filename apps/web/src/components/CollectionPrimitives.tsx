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
  Typography,
} from "@mui/material";
import type { ProjectDto, ProjectSort } from "@ponderosa/core";
import { useId, type DragEvent, type ReactNode } from "react";
import { IconTitle } from "./IconTitle";

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

export function CollectionHeader({
  title,
  detail,
  icon,
  scope,
  primaryAction,
}: Pick<CollectionWorkspaceProps, "title" | "detail" | "icon" | "scope" | "primaryAction">): JSX.Element {
  return <Stack
    component="header"
    direction={{ xs: "column", sm: "row" }}
    spacing={1.5}
    sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: { sm: "center" }, borderBottom: 1, borderColor: "divider" }}
  >
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
        {icon ? <IconTitle icon={icon} title={title} component="h1" /> : <Typography variant="h6" component="h1" fontWeight={800}>{title}</Typography>}
        {scope}
      </Stack>
      {detail ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.15 }}>{detail}</Typography> : null}
    </Box>
    {primaryAction}
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
  return <Box
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
  </Box>;
}

export interface CollectionToolbarProps {
  search: string;
  onSearch(value: string): void;
  searchLabel: string;
  children?: ReactNode;
}

export function CollectionToolbar({ search, onSearch, searchLabel, children }: CollectionToolbarProps): JSX.Element {
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
      sx={{ flex: 1, minWidth: { md: 240 } }}
    />
    {children}
  </Stack>;
}

export function CollectionDirectoryControls({
  projects,
  projectId,
  onProject,
  sort,
  onSort,
}: {
  projects?: ProjectDto[];
  projectId?: string;
  onProject?(value: string): void;
  sort: ProjectSort;
  onSort(value: ProjectSort): void;
}): JSX.Element {
  const controlId = useId();
  return <>
    {projects && onProject ? (
      <FormControl
        size="small"
        sx={{ minWidth: 190, width: { xs: "100%", sm: "auto" } }}
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
      sx={{ minWidth: 170, width: { xs: "100%", sm: "auto" } }}
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
  highlighted = false,
}: ResourceRowProps): JSX.Element {
  return <Paper
    variant="outlined"
    draggable={draggable}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
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
      onContextMenu(event.currentTarget);
    }}
    sx={{
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
      component="div"
      role="button"
      tabIndex={0}
      aria-label={`Open ${label}`}
      onClick={onOpen}
      onKeyDown={(event) => {
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
