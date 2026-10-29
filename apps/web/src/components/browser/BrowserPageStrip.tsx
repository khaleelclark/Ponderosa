import CloseIcon from "@mui/icons-material/Close";
import LanguageIcon from "@mui/icons-material/Language";
import AddIcon from "@mui/icons-material/Add";
import { Box, CircularProgress, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import type { BrowserPageDto } from "@ponderosa/core";

export function BrowserPageStrip({
  pages,
  activePageId,
  canManage,
  busy,
  onActivate,
  onClose,
  onNew,
  agentPageId,
  loadingPageId,
}: {
  pages: BrowserPageDto[];
  activePageId?: string;
  canManage: boolean;
  busy?: boolean;
  onActivate(pageId: string): void;
  onClose(pageId: string): void;
  onNew?(): void;
  agentPageId?: string;
  loadingPageId?: string;
}): JSX.Element | null {
  if (pages.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.25} sx={{ minWidth: 0, overflow: "hidden", height: 26 }}>
      <Stack direction="row" spacing={0.25} role="tablist" aria-label="Browser pages"
        sx={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
      {pages.map((page) => {
        const active = activePageId ? page.id === activePageId : page.active;
        const label = page.title?.trim() || (() => {
          try { return page.url ? new URL(page.url).origin : "New page"; }
          catch { return "New page"; }
        })();
        return (
          <Box key={page.id} role="tab" aria-selected={active}
            title={label} aria-label={label}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || busy) return;
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(page.id); }
              if (event.key === "Delete" && canManage && page.closable) { event.preventDefault(); onClose(page.id); }
            }}
            onClick={() => { if (!active && !busy) onActivate(page.id); }}
            sx={{ flex: "1 1 130px", minWidth: active ? 40 : 0, maxWidth: 130, display: "flex", overflow: "hidden", containerType: "inline-size",
              alignItems: "center", gap: 0.25, px: 0.25, py: 0, borderRadius: 0.75,
              "& .tab-icon": { flexShrink: 0, "@container (max-width: 55px)": { display: "none" } },
              "& .tab-close": { flexShrink: 0, "@container (max-width: 70px)": { display: active ? "inline-flex" : "none" } },
              bgcolor: active ? "action.selected" : "action.hover", border: 1,
              borderColor: active ? "primary.main" : "divider",
              cursor: !active ? "pointer" : "default" }}>
            {page.loading || loadingPageId === page.id ? <CircularProgress className="tab-icon" size={13} aria-label="Loading page" /> : <LanguageIcon className="tab-icon" sx={{ fontSize: 14 }} color={active ? "primary" : "disabled"} />}
            <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontSize: 12 }}>{label}</Typography>
            {agentPageId === page.id ? <Tooltip title="Agent is working in this tab"><Box aria-label="Agent working tab" sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "info.main", flexShrink: 0 }} /></Tooltip> : null}
            {canManage && page.closable ? (
              <Tooltip title="Close page"><span className="tab-close">
                <IconButton size="small" sx={{ p: .25, fontSize: 14 }} aria-label={"Close " + label} disabled={busy}
                  onClick={(event) => { event.stopPropagation(); onClose(page.id); }}>
                  <CloseIcon fontSize="inherit" />
                </IconButton>
              </span></Tooltip>
            ) : null}
          </Box>
        );
      })}
      </Stack>
      {onNew ? <Tooltip title={canManage ? "New tab" : "Take control to open a tab"}><span style={{ flexShrink: 0 }}><IconButton size="small" sx={{ p: .5, "& svg": { fontSize: 16 } }} aria-label="New browser tab" disabled={!canManage || busy || pages.length >= 30} onClick={onNew}><AddIcon /></IconButton></span></Tooltip> : null}
    </Stack>
  );
}
