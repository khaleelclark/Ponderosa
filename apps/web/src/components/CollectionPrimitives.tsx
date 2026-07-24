import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";

export interface CollectionHeaderProps {
  title: string;
  detail?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}

export function CollectionHeader({ title, detail, icon, actions }: CollectionHeaderProps): JSX.Element {
  return <Stack
    component="header"
    direction={{ xs: "column", sm: "row" }}
    spacing={1.5}
    sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: { sm: "center" }, borderBottom: 1, borderColor: "divider" }}
  >
    <Stack direction="row" spacing={1.25} sx={{ flex: 1, minWidth: 0, alignItems: "center" }}>
      {icon ? <Box sx={{ width: 42, height: 42, flex: "0 0 auto", borderRadius: 2, bgcolor: "action.selected", display: "grid", placeItems: "center", color: "primary.main" }}>{icon}</Box> : null}
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h5" component="h1" fontWeight={850}>{title}</Typography>
        {detail ? <Typography variant="body2" color="text.secondary">{detail}</Typography> : null}
      </Box>
    </Stack>
    {actions}
  </Stack>;
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
    sx={{ p: { xs: 2, md: 3 }, pb: 1.5 }}
  >
    <TextField
      size="small"
      value={search}
      onChange={(event) => onSearch(event.target.value)}
      placeholder="Search"
      inputProps={{ "aria-label": searchLabel }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
      sx={{ flex: 1 }}
    />
    {children}
  </Stack>;
}

export interface ResourceRowProps {
  label: string;
  description?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  onOpen(): void;
  onContextMenu?(anchor: HTMLElement): void;
  draggable?: boolean;
  onDragStart?(): void;
  onDragEnd?(): void;
  onDrop?(): void;
}

export function ResourceRow({
  label,
  description,
  icon,
  meta,
  trailing,
  onOpen,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  onDrop,
}: ResourceRowProps): JSX.Element {
  return <Paper
    variant="outlined"
    draggable={draggable}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    onDragOver={(event) => {
      if (!onDrop) return;
      event.preventDefault();
    }}
    onDrop={(event) => {
      if (!onDrop) return;
      event.preventDefault();
      onDrop();
    }}
    onContextMenu={(event) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu(event.currentTarget);
    }}
    sx={{ display: "flex", alignItems: "stretch", overflow: "hidden" }}
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
        p: 1.75,
        display: "flex",
        alignItems: "center",
        textAlign: "left",
        cursor: "pointer",
        gap: 1.5,
        "&:hover": { bgcolor: "action.hover" },
        "&:focus-visible": { outline: "2px solid var(--ponderosa-focus-ring)", outlineOffset: -2 },
      }}
    >
      {icon}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography fontWeight={800} noWrap>{label}</Typography>
        {description ? <Typography component="div" variant="body2" color="text.secondary" noWrap>{description}</Typography> : null}
      </Box>
      {meta}
    </Box>
    {trailing}
  </Paper>;
}
