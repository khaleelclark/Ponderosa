import MoreVertIcon from "@mui/icons-material/MoreVert";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import {
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  MenuList,
  Popover,
  Tooltip,
} from "@mui/material";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { copyText } from "../clipboard";
import { downloadMarkdownTranscript } from "../chatTranscript";
import { useMutationNotification } from "./MutationNotifications";

export interface ChatOverflowAction {
  label: string;
  onSelect(anchor: HTMLElement): void;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}

const CHAT_EXPORT_ACTION_LABELS = ["Copy", "Download", "Chat Transcript"] as const;
const menuRowSx = { minHeight: { xs: 44, sm: 36 }, py: 0.75 } as const;

export function ChatOverflowMenu({
  label = "Chat Actions",
  actions,
  copyActions = [],
  downloadActions = [],
  transcriptMarkdown,
  transcriptFileName,
  details,
  detailsLabel = "Setup",
  showExports = true,
}: {
  label?: string;
  actions: ChatOverflowAction[];
  copyActions?: ChatOverflowAction[];
  downloadActions?: ChatOverflowAction[];
  transcriptMarkdown: string;
  transcriptFileName: string;
  details?: ReactNode;
  detailsLabel?: string;
  showExports?: boolean;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [detailsAnchor, setDetailsAnchor] = useState<HTMLElement | null>(null);
  const [exportMenu, setExportMenu] = useState<{ kind: "copy" | "download"; anchor: HTMLElement }>();
  const notify = useMutationNotification();
  const close = () => setAnchor(null);
  const afterMenuClose = useRef<(() => void)>();
  const finishMenuAction = () => {
    const action = afterMenuClose.current;
    afterMenuClose.current = undefined;
    action?.();
  };
  const run = (action: ChatOverflowAction["onSelect"]) => {
    const mainAnchor = anchor;
    if (!mainAnchor?.isConnected || afterMenuClose.current) return;
    // Let the old focus trap finish before another dialog or popover opens.
    afterMenuClose.current = () => { if (mainAnchor.isConnected) action(mainAnchor); };
    close();
  };
  return <>
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ display: "inline-flex" }}
      >
        <MoreVertIcon />
      </IconButton>
    </Tooltip>
    <Menu
      anchorEl={anchor}
      open={Boolean(anchor)}
      onClose={close}
      TransitionProps={{ onExited: finishMenuAction }}
      MenuListProps={{ "aria-label": label, dense: true }}
      slotProps={{ paper: { sx: { minWidth: 240, maxWidth: "min(360px, calc(100vw - 24px))", "& .MuiMenuItem-root": { minHeight: { xs: 44, sm: 36 }, py: 0.75 } } } }}
    >
      {details ? <MenuItem sx={menuRowSx} onClick={() => run(setDetailsAnchor)}>
        <ListItemIcon><TuneOutlinedIcon fontSize="small" /></ListItemIcon>
        <ListItemText>{detailsLabel}</ListItemText>
      </MenuItem> : null}
      {details ? <Divider /> : null}
      {actions.map((action) => <MenuItem
        key={action.label}
        disabled={action.disabled}
        onClick={() => run(action.onSelect)}
        sx={{ ...menuRowSx, ...(action.destructive ? { color: "error.main" } : {}) }}
      >
        {action.icon ? <ListItemIcon sx={action.destructive ? { color: "inherit" } : undefined}>{action.icon}</ListItemIcon> : null}
        <ListItemText>{action.label}</ListItemText>
      </MenuItem>)}
      {actions.length && showExports ? <Divider /> : null}
      {showExports ? <MenuItem sx={menuRowSx} onClick={() => run(anchor => setExportMenu({ kind: "copy", anchor }))}>
        <ListItemIcon><ContentCopyOutlinedIcon fontSize="small" /></ListItemIcon>
        <ListItemText>{CHAT_EXPORT_ACTION_LABELS[0]}</ListItemText>
        <ChevronRightIcon fontSize="small" />
      </MenuItem> : null}
      {showExports ? <MenuItem sx={menuRowSx} onClick={() => run(anchor => setExportMenu({ kind: "download", anchor }))}>
        <ListItemIcon><DownloadOutlinedIcon fontSize="small" /></ListItemIcon>
        <ListItemText>{CHAT_EXPORT_ACTION_LABELS[1]}</ListItemText>
        <ChevronRightIcon fontSize="small" />
      </MenuItem> : null}
    </Menu>
    <Popover
      open={Boolean(exportMenu)}
      anchorEl={exportMenu?.anchor}
      onClose={() => setExportMenu(undefined)}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      slotProps={{ paper: { sx: { minWidth: 260, maxWidth: "min(360px, calc(100vw - 24px))", "& .MuiMenuItem-root": { minHeight: { xs: 44, sm: 36 }, py: 0.75 } } } }}
    >
      <MenuList dense aria-label={`${exportMenu?.kind === "download" ? "Download" : "Copy"} options`}>
        {(exportMenu?.kind === "download" ? downloadActions : copyActions).map((action) => <MenuItem
          key={action.label}
          sx={menuRowSx}
          disabled={action.disabled}
          onClick={() => {
            const mainAnchor = exportMenu?.anchor;
            if (!mainAnchor?.isConnected) return;
            setExportMenu(undefined);
            action.onSelect(mainAnchor);
          }}
        >
          {action.icon ? <ListItemIcon>{action.icon}</ListItemIcon> : null}
          <ListItemText>{action.label}</ListItemText>
        </MenuItem>)}
        {(exportMenu?.kind === "download" ? downloadActions : copyActions).length ? <Divider /> : null}
        <MenuItem sx={menuRowSx} onClick={() => {
          const kind = exportMenu?.kind;
          setExportMenu(undefined);
          if (kind === "download") {
            downloadMarkdownTranscript(transcriptMarkdown, transcriptFileName);
            return;
          }
          void copyText(transcriptMarkdown)
            .then(() => notify({ key: "copy-transcript", message: "Copied" }))
            .catch((error) => notify({ key: "copy-transcript", message: error instanceof Error ? error.message : "Chat transcript could not be copied", severity: "error" }));
        }}>
          <ListItemIcon>{exportMenu?.kind === "download" ? <DownloadOutlinedIcon fontSize="small" /> : <ContentCopyOutlinedIcon fontSize="small" />}</ListItemIcon>
          <ListItemText>{CHAT_EXPORT_ACTION_LABELS[2]}</ListItemText>
        </MenuItem>
      </MenuList>
    </Popover>
    <Popover
      open={Boolean(detailsAnchor)}
      anchorEl={detailsAnchor}
      onClose={() => setDetailsAnchor(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      slotProps={{ paper: { sx: { width: 300, maxWidth: "calc(100vw - 24px)", p: 1.5 } } }}
    >
      {details}
    </Popover>
  </>;
}
