import { Chip, Tooltip } from "@mui/material";
import type { UnreadNotificationProjection } from "../workspaceNavigation";

/** Exact server-deduped total; importance changes emphasis, never identity/count. */
export function SidebarNotificationBadge({ unread }: { unread?: UnreadNotificationProjection }) {
  if (!unread?.totalCount) return null;
  const detail = `${unread.totalCount} unread notifications: ${unread.importantCount} important; ${unread.ordinaryCount} ordinary`;
  return <Tooltip title={detail}>
    <Chip component="span" role="img" data-sidebar-column="unread" size="small" color={unread.importantCount ? "error" : "default"}
      label={unread.totalCount > 99 ? "99+" : unread.totalCount}
      aria-label={detail} title={detail} tabIndex={0}
      sx={{ height: 18, minWidth: 18, flexShrink: 0, fontSize: 11, fontVariantNumeric: "tabular-nums", "& .MuiChip-label": { px: .5 } }} />
  </Tooltip>;
}
