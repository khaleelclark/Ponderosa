import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import {
  Badge,
  Box,
  Button,
  IconButton,
  InputAdornment,
  List,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import { IconTitle } from "./IconTitle";
import { sidebarSurface } from "./WorkspaceSidebar.helpers";

function SidebarSectionHeading({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <Typography
      variant="subtitle2"
      color="text.secondary"
      sx={{
        px: 1,
        mb: 0.5,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: ".06em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </Typography>
  );
}

function SharedSidebarPanel({
  icon,
  title,
  total,
  searchLabel,
  searchValue,
  onSearchValueChange,
  topContent,
  starredRows,
  allRows,
  empty,
  loadMoreLabel,
  onLoadMore,
  loadingMore = false,
  newLabel,
  newIcon,
  onNew,
  onNewContextMenu,
  newDisabled = false,
  viewAllLabel,
  viewAllIcon,
  onViewAll,
  onViewAllContextMenu,
  drawer,
}: {
  icon: ReactNode;
  title: string;
  total: number;
  searchLabel: string;
  searchValue: string;
  onSearchValueChange(value: string): void;
  topContent?: ReactNode;
  starredRows: ReactNode;
  allRows: ReactNode;
  empty?: ReactNode;
  loadMoreLabel?: string;
  onLoadMore?(): void;
  loadingMore?: boolean;
  newLabel?: string;
  newIcon?: ReactNode;
  onNew?(): void;
  onNewContextMenu?(anchor: HTMLElement): void;
  newDisabled?: boolean;
  viewAllLabel: string;
  viewAllIcon: ReactNode;
  onViewAll(): void;
  onViewAllContextMenu?(anchor: HTMLElement): void;
  drawer: boolean;
}): JSX.Element {
  return (
    <Box
      data-sidebar-layout="shared-resource"
      data-sidebar-panel={title.toLocaleLowerCase()}
      sx={{
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto auto minmax(0, 1fr) auto",
        bgcolor: sidebarSurface,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "baseline",
          pl: 2.25,
          pr: drawer ? 7 : 2.25,
          pt: 2,
          pb: 1.25,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <IconTitle icon={icon} title={title} />
        </Box>
        <Typography variant="caption" color="text.secondary">
          {total} total
        </Typography>
      </Stack>
      <Box sx={{ px: 1.75, pb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          value={searchValue}
          onChange={event => onSearchValueChange(event.target.value)}
          placeholder={searchLabel}
          inputProps={{ "aria-label": searchLabel }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
      </Box>
      <Box
        data-testid="workspace-navigation-scroll"
        className="ponderosa-scroll"
        sx={{ minHeight: 0, overflowY: "auto", px: 1.25, pb: 1.5 }}
      >
        {topContent}
        <Box component="section" data-sidebar-section="starred" sx={{ mb: 2 }}>
          <SidebarSectionHeading>Starred</SidebarSectionHeading>
          <List disablePadding>{starredRows}</List>
        </Box>
        <Box component="section" data-sidebar-section="all">
          <SidebarSectionHeading>
            {title === "Home" ? "Recents" : `All ${title}`}
          </SidebarSectionHeading>
          <List disablePadding>{allRows}</List>
        </Box>
        {empty}
        {loadMoreLabel && onLoadMore ? (
          <Button
            fullWidth
            color="inherit"
            disabled={loadingMore}
            onClick={onLoadMore}
            sx={{ mt: 1, color: "text.secondary" }}
          >
            {loadingMore ? "Loading…" : loadMoreLabel}
          </Button>
        ) : null}
      </Box>
      <Box
        sx={{
          p: 1.75,
          boxShadow: theme => `inset 0 1px 0 ${theme.palette.divider}`,
        }}
      >
        {newLabel && onNew ? (
          <Button
            fullWidth
            color="inherit"
            startIcon={newIcon ?? <AddIcon />}
            onClick={onNew}
            onContextMenu={event => {
              if (!onNewContextMenu) return;
              event.preventDefault();
              onNewContextMenu(event.currentTarget);
            }}
            disabled={newDisabled}
            sx={{
              justifyContent: "flex-start",
              color: "text.secondary",
            }}
          >
            {newLabel}
          </Button>
        ) : null}
        <Button
          fullWidth
          startIcon={viewAllIcon}
          onClick={onViewAll}
          onContextMenu={event => {
            if (!onViewAllContextMenu) return;
            event.preventDefault();
            onViewAllContextMenu(event.currentTarget);
          }}
          sx={{
            justifyContent: "flex-start",
            color: "text.secondary",
          }}
        >
          {viewAllLabel}
        </Button>
      </Box>
    </Box>
  );
}

function RailButton({
  label,
  selected = false,
  badge,
  badgeColor = "primary",
  children,
  onClick,
}: {
  label: string;
  selected?: boolean;
  badge?: number;
  badgeColor?: "primary" | "info" | "error";
  children: ReactNode;
  onClick(): void;
}): JSX.Element {
  return (
    <Tooltip title={label} placement="right">
      <IconButton
        aria-label={label}
        onClick={onClick}
        sx={{
          width: 48,
          height: 48,
          borderRadius: 1,
          color: selected
            ? "var(--ponderosa-rail-foreground-active)"
            : "var(--ponderosa-rail-foreground)",
          bgcolor: selected ? "rgba(124, 191, 138, .14)" : "transparent",
          "&:hover": {
            bgcolor: selected
              ? "rgba(124, 191, 138, .20)"
              : "rgba(178, 187, 180, .10)",
            color: "#E6E7DF",
          },
        }}
      >
        <Badge color={badgeColor} badgeContent={badge} max={99}>
          {children}
        </Badge>
      </IconButton>
    </Tooltip>
  );
}

export { RailButton, SharedSidebarPanel, SidebarSectionHeading };
