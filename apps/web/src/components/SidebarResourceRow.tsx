import type { ReactNode, MouseEvent } from "react";
import { Box, IconButton, ListItemButton, ListItemIcon, ListItemText, Tooltip } from "@mui/material";
import { alpha } from "@mui/material/styles";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import { starColor } from "./WorkspaceSidebar.helpers";

/** One row presentation for every sidebar resource; ownership/actions stay with callers. */
export function SidebarResourceRow({ id, label, title, detail, icon, selected, starred, emphasis, nested, status, onOpen, onStar, onMore }: {
  id: string; label: string; title: string; detail?: string; icon: ReactNode;
  selected?: boolean; starred: boolean; emphasis?: boolean; nested?: boolean; status?: ReactNode;
  onOpen(): void; onStar(): void; onMore?(anchor: HTMLElement): void;
}) {
  const control = { width: { xs: 44, sm: 32 }, height: { xs: 44, sm: 32 }, minHeight: { xs: 44, sm: 32 }, minWidth: { xs: 44, sm: 32 }, flexShrink: 0 };
  return <Box sx={{ display: "flex", flex: 1, minWidth: 0, alignItems: "center", "@media (hover: hover) and (pointer: fine)": { "& .sidebar-secondary": { opacity: 0 }, "&:hover .sidebar-secondary, &:focus-within .sidebar-secondary": { opacity: 1 } } }}>
    <Tooltip title={detail ? `${title} · ${detail}` : title} placement="right" disableInteractive>
      <ListItemButton data-resource-id={id} aria-label={label} selected={selected} onClick={onOpen}
        onKeyDown={event => { if (onMore && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); onMore(event.currentTarget); } }}
        sx={theme => ({ borderRadius: 1.25, px: 1, py: 0, minWidth: 0, height: { xs: 44, sm: 32 }, minHeight: { xs: 44, sm: 32 }, ...(nested ? {
          bgcolor: alpha(theme.palette.primary.main, .07),
          boxShadow: `inset 2px 0 ${alpha(theme.palette.primary.main, .55)}`,
          "&:hover": { bgcolor: alpha(theme.palette.primary.main, .12) },
          "&.Mui-selected": { bgcolor: alpha(theme.palette.primary.main, .20), "&:hover": { bgcolor: alpha(theme.palette.primary.main, .24) } },
        } : {}) })}>
        <ListItemIcon sx={{ minWidth: 30 }}>{icon}</ListItemIcon>
        <ListItemText primary={title} sx={{ my: 0, mr: 1, minWidth: 0, flex: "1 1 0" }} primaryTypographyProps={{ noWrap: true, fontSize: 14, fontWeight: emphasis ? 800 : starred ? 750 : 500 }} />
        <Box sx={{ display: "flex", alignItems: "center", gap: .5 }}>{status}</Box>
      </ListItemButton>
    </Tooltip>
    <IconButton className={starred ? undefined : "sidebar-secondary"} size="small" aria-label={`${starred ? "Unstar" : "Star"} ${title}`} onClick={onStar} sx={control}>
      {starred ? <StarRoundedIcon fontSize="small" sx={{ color: starColor }} /> : <StarBorderRoundedIcon fontSize="small" />}
    </IconButton>
    {onMore ? <IconButton className="sidebar-secondary" size="small" aria-label={`Actions for ${title}`} onClick={(event: MouseEvent<HTMLElement>) => onMore(event.currentTarget)} sx={{ ...control, width: { xs: 44, sm: 28 }, minWidth: { xs: 44, sm: 28 } }}><MoreHorizIcon fontSize="small" /></IconButton> : null}
  </Box>;
}
