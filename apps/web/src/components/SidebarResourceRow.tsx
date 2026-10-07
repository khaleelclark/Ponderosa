import type { ReactNode } from "react";
import { Box, IconButton, ListItemButton, ListItemIcon, ListItemText, Tooltip } from "@mui/material";
import { alpha } from "@mui/material/styles";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import { starColor } from "./WorkspaceSidebar.helpers";

/** One row presentation for every sidebar resource; ownership/actions stay with callers. */
export function SidebarResourceRow({ id, label, title, detail, subtitle, icon, selected, currentPage, disabled, starred = false, emphasis, boldWhenStarred = true, nested, status, onOpen, onStar, onContextAction }: {
  id: string; label: string; title: string; detail?: string; subtitle?: string; icon: ReactNode;
  selected?: boolean; currentPage?: boolean; disabled?: boolean; starred?: boolean; emphasis?: boolean; boldWhenStarred?: boolean; nested?: boolean; status?: ReactNode;
  onOpen(): void; onStar?(): void; onContextAction?(anchor: HTMLElement): void;
}) {
  const coarseTarget = { "@media (pointer: coarse)": { width: 44, height: 44, minWidth: 44, minHeight: 44 } };
  const control = { width: { xs: 44, sm: 32 }, height: { xs: 44, sm: 32 }, minHeight: { xs: 44, sm: 32 }, minWidth: { xs: 44, sm: 32 }, flexShrink: 0, ...coarseTarget };
  const rowHeight = subtitle ? { xs: 52, sm: 44 } : { xs: 44, sm: 32 };
  return <Box sx={{ display: "flex", flex: 1, minWidth: 0, alignItems: "center", "@media (hover: hover) and (pointer: fine)": { "& .sidebar-secondary": { opacity: 0 }, "&:hover .sidebar-secondary, &:focus-within .sidebar-secondary": { opacity: 1 } } }}>
    <Tooltip title={detail ? `${title} · ${detail}` : title} placement="right" disableInteractive>
      <ListItemButton data-resource-id={id} aria-label={label} aria-haspopup={onContextAction ? "menu" : undefined} selected={selected} aria-current={currentPage ? "page" : undefined} disabled={disabled} onClick={onOpen}
        onKeyDown={event => { if (onContextAction && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); onContextAction(event.currentTarget); } }}
        sx={theme => ({ borderRadius: 1.25, px: 1, py: 0, minWidth: 0, height: rowHeight, minHeight: rowHeight, "@media (pointer: coarse)": { minHeight: subtitle ? 52 : 44, height: subtitle ? 52 : 44 }, ...(nested ? {
          bgcolor: alpha(theme.palette.primary.main, .07),
          boxShadow: `inset 2px 0 ${alpha(theme.palette.primary.main, .55)}`,
          "&:hover": { bgcolor: alpha(theme.palette.primary.main, .12) },
          "&.Mui-selected": { bgcolor: alpha(theme.palette.primary.main, .20), "&:hover": { bgcolor: alpha(theme.palette.primary.main, .24) } },
        } : {}) })}>
        <ListItemIcon sx={{ minWidth: 30 }}>{icon}</ListItemIcon>
        <ListItemText primary={title} secondary={subtitle} sx={{ my: 0, mr: 1, minWidth: 0, flex: "1 1 0" }} primaryTypographyProps={{ noWrap: true, fontSize: 14, fontWeight: emphasis ? 800 : starred && boldWhenStarred ? 750 : 500 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
        <Box sx={{ display: "flex", alignItems: "center", gap: .5 }}>{status}</Box>
      </ListItemButton>
    </Tooltip>
    {onStar ? <IconButton className={starred || selected ? undefined : "sidebar-secondary"} size="small" aria-label={`${starred ? "Unstar" : "Star"} ${title}`} onClick={onStar} sx={control}>
      {starred ? <StarRoundedIcon fontSize="small" sx={{ color: starColor }} /> : <StarBorderRoundedIcon fontSize="small" />}
    </IconButton> : null}
  </Box>;
}
