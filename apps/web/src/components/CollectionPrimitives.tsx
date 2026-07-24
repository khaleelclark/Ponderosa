import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { DragEvent, ReactNode } from "react";

export interface CollectionWorkspaceProps {
  title: string;
  detail?: string;
  icon?: ReactNode;
  scope?: ReactNode;
  primaryAction?: ReactNode;
  toolbar: ReactNode;
  children: ReactNode;
  listLabel: string;
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
    <Stack direction="row" spacing={1.25} sx={{ flex: 1, minWidth: 0, alignItems: "center" }}>
      {icon ? <Box sx={{ width: 42, height: 42, flex: "0 0 auto", borderRadius: 2, bgcolor: "action.selected", display: "grid", placeItems: "center", color: "primary.main" }}>{icon}</Box> : null}
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
          <Typography variant="h5" component="h1" fontWeight={850}>{title}</Typography>
          {scope}
        </Stack>
        {detail ? <Typography variant="body2" color="text.secondary">{detail}</Typography> : null}
      </Box>
    </Stack>
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
}: CollectionWorkspaceProps): JSX.Element {
  return <Box className="ponderosa-scroll" sx={{ height: "100%", minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden" }}>
    <CollectionHeader title={title} detail={detail} icon={icon} scope={scope} primaryAction={primaryAction} />
    {toolbar}
    <Stack component="section" aria-label={listLabel} spacing={0.75} sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>
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
  onDragStart?(): void;
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
      component="button"
      type="button"
      aria-label={`Open ${label}`}
      onClick={onOpen}
      sx={{
        appearance: "none",
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
