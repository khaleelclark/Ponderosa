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
import { Children, type ReactNode } from "react";
import { useInfiniteScrollSentinel } from "../hooks/useInfiniteScrollSentinel";
import { IconTitle } from "./IconTitle";
import { LoadingState } from "./LoadingState";
import { railSurface, sidebarSurface } from "./WorkspaceSidebar.helpers";

function SidebarSectionHeading({
  children,
  actionLabel,
  onAction,
  titleCase = false,
}: {
  children: ReactNode;
  actionLabel?: string;
  onAction?(): void;
  titleCase?: boolean;
}): JSX.Element {
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: "center",
        px: 1,
        mb: 0.5,
      }}
    >
      <Typography
        variant="subtitle2"
        color="text.secondary"
        noWrap
        sx={{
          minWidth: 0,
          flex: 1,
          fontSize: titleCase ? 13 : 11,
          fontWeight: 800,
          letterSpacing: titleCase ? 0 : ".06em",
          textTransform: titleCase ? "none" : "uppercase",
        }}
      >
        {children}
      </Typography>
      {actionLabel && onAction ? (
        <Tooltip title={actionLabel}>
          <IconButton
            size="small"
            aria-label={actionLabel}
            onClick={onAction}
            sx={{ width: 36, height: 36, flex: "0 0 auto" }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

function SharedSidebarPanel({
  icon,
  title,
  header,
  total,
  searchLabel,
  searchValue,
  onSearchValueChange,
  hideSearch = false,
  topContent,
  starredRows,
  allRows,
  empty,
  collectionFeedback,
  busy = false,
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
  createLabel,
  onCreate,
  drawer,
}: {
  icon: ReactNode;
  title: string;
  header?: ReactNode;
  total?: number;
  searchLabel: string;
  searchValue: string;
  onSearchValueChange(value: string): void;
  hideSearch?: boolean;
  topContent?: ReactNode;
  starredRows: ReactNode;
  allRows: ReactNode;
  empty?: ReactNode;
  collectionFeedback?: ReactNode;
  busy?: boolean;
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
  createLabel?: string;
  onCreate?(): void;
  drawer: boolean;
}): JSX.Element {
  const hasStarredRows = Children.count(starredRows) > 0;
  return (
    <Box
      sx={{
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "auto auto minmax(0, 1fr) auto",
        bgcolor: sidebarSurface,
      }}
    >
      {header ?? (
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
          {total == null ? null : <Typography variant="caption" color="text.secondary">
            {total} total
          </Typography>}
        </Stack>
      )}
      {hideSearch ? <Box /> : <Box sx={{ px: 1.75, pb: 1.5 }}>
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
      </Box>}
      <Box
        aria-busy={busy}
        className="ponderosa-scroll"
        sx={{
          minHeight: 0,
          minWidth: 0,
          overflowX: "hidden",
          overflowY: "auto",
          px: 1.25,
          pb: 1.5,
        }}
      >
        {topContent}
        {hasStarredRows ? (
          <Box component="section" sx={{ mb: 2 }}>
            <SidebarSectionHeading>Starred</SidebarSectionHeading>
            <List disablePadding>{starredRows}</List>
          </Box>
        ) : null}
        <Box component="section">
          <SidebarSectionHeading
            titleCase={title !== "Home"}
            actionLabel={createLabel}
            onAction={onCreate}
          >
            {title === "Home" ? "Recents" : `All ${title}`}
          </SidebarSectionHeading>
          <List disablePadding>{allRows}</List>
        </Box>
        {empty}
        {collectionFeedback}
        {loadMoreLabel && onLoadMore ? (
          <SidebarPagination
            title={title}
            label={loadMoreLabel}
            loading={loadingMore}
            onLoadMore={onLoadMore}
          />
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

function SidebarPagination({
  title,
  label,
  loading,
  onLoadMore,
}: {
  title: string;
  label: string;
  loading: boolean;
  onLoadMore(): void;
}): JSX.Element {
  const sentinelRef = useInfiniteScrollSentinel({
    enabled: true,
    loading,
    onLoadMore,
  });
  return (
    <Stack ref={sentinelRef} spacing={0.5} sx={{ mt: 1 }}>
      {loading ? <LoadingState resource={title} variant="inline" /> : null}
      <Button
        fullWidth
        color="inherit"
        disabled={loading}
        onClick={onLoadMore}
        sx={{ color: "text.secondary" }}
      >
        {label}
      </Button>
    </Stack>
  );
}

function RailButton({
  label,
  selected = false,
  badge,
  dot = false,
  badgeColor = "primary",
  badgeStatus,
  dotStatus = "unread activity",
  children,
  onClick,
}: {
  label: string;
  selected?: boolean;
  badge?: number;
  dot?: boolean;
  badgeColor?: "default" | "primary" | "info" | "error";
  badgeStatus?: string;
  dotStatus?: string;
  children: ReactNode;
  onClick(): void;
}): JSX.Element {
  return (
    <Tooltip title={label} placement="right">
      <IconButton
        aria-label={badge
          ? `${label}, ${badgeStatus ?? badge}`
          : dot
            ? `${label}, ${dotStatus}`
            : label}
        onClick={onClick}
        sx={{
          position: "relative",
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
        <Badge
          color={badgeColor}
          badgeContent={badge}
          variant={dot && !badge ? "dot" : "standard"}
          invisible={!badge && !dot}
          max={99}
          slotProps={{ badge: { "aria-hidden": true } }}
          sx={{ "& .MuiBadge-badge": { color: "#fff", fontWeight: 800 } }}
        >
          {children}
        </Badge>
        {badge && dot ? (
          <Box
            component="span"
            aria-hidden
            sx={{ position: "absolute", right: 7, bottom: 7, width: 8, height: 8, borderRadius: "50%", bgcolor: "text.secondary", border: `2px solid ${railSurface}` }}
          />
        ) : null}
      </IconButton>
    </Tooltip>
  );
}

export { RailButton, SharedSidebarPanel, SidebarSectionHeading };
