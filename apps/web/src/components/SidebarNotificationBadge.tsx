import { Box, Chip } from "@mui/material";
import type { UnreadNotificationProjection } from "../workspaceNavigation";

/** Shared Chat/folder indicators; independent of hover-only row actions. */
export function SidebarNotificationBadge({ unread }: { unread: UnreadNotificationProjection }) {
  return <>
    {unread.importantCount > 0 ? <Chip role="img" size="small" color="error" label={unread.importantCount > 99 ? "99+" : unread.importantCount}
      aria-label={`${unread.importantCount} important unread`} sx={{ height: 20, flexShrink: 0 }} /> : null}
    {unread.ordinaryCount > 0 ? <Box role="img" aria-label={`${unread.ordinaryCount} ordinary unread`}
      sx={{ width: 8, height: 8, flexShrink: 0, borderRadius: "50%", bgcolor: "text.secondary" }} /> : null}
  </>;
}
