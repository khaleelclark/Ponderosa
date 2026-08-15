import CloseIcon from "@mui/icons-material/Close";
import LanguageIcon from "@mui/icons-material/Language";
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import type { BrowserPageDto } from "@ponderosa/core";

export function BrowserPageStrip({
  pages,
  activePageId,
  canManage,
  busy,
  onActivate,
  onClose,
}: {
  pages: BrowserPageDto[];
  activePageId?: string;
  canManage: boolean;
  busy?: boolean;
  onActivate(pageId: string): void;
  onClose(pageId: string): void;
}): JSX.Element | null {
  if (pages.length < 2) return null;
  return (
    <Stack direction="row" spacing={0.75} role="tablist" aria-label="Browser pages"
      sx={{ minWidth: 0, overflowX: "auto", pb: 0.25, scrollbarWidth: "thin" }}>
      {pages.map((page) => {
        const active = page.id === activePageId || page.active;
        const label = page.title?.trim() || (() => {
          try { return page.url ? new URL(page.url).origin : "New page"; }
          catch { return "New page"; }
        })();
        return (
          <Box key={page.id} role="tab" aria-selected={active}
            onClick={() => { if (!active && canManage && !busy) onActivate(page.id); }}
            sx={{ flex: "0 0 auto", minWidth: 140, maxWidth: 260, display: "flex",
              alignItems: "center", gap: 0.5, px: 1, py: 0.5, borderRadius: 1.5,
              bgcolor: active ? "action.selected" : "action.hover", border: 1,
              borderColor: active ? "primary.main" : "divider",
              cursor: canManage && !active ? "pointer" : "default" }}>
            <LanguageIcon fontSize="small" color={active ? "primary" : "disabled"} />
            <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>{label}</Typography>
            {page.isNew ? <Chip size="small" label="New" color="info" sx={{ height: 20 }} /> : null}
            {canManage && page.closable ? (
              <Tooltip title="Close page"><span>
                <IconButton size="small" aria-label={"Close " + label} disabled={busy}
                  onClick={(event) => { event.stopPropagation(); onClose(page.id); }}>
                  <CloseIcon fontSize="inherit" />
                </IconButton>
              </span></Tooltip>
            ) : null}
          </Box>
        );
      })}
    </Stack>
  );
}
