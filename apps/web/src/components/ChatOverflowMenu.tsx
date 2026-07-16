import MoreVertIcon from "@mui/icons-material/MoreVert";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import {
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Snackbar,
  Tooltip,
} from "@mui/material";
import type { ReactNode } from "react";
import { useState } from "react";
import { copyText } from "../clipboard";
import { downloadMarkdownTranscript } from "../chatTranscript";

export interface ChatOverflowAction {
  label: string;
  onSelect(): void;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}

export const CHAT_TRANSCRIPT_ACTION_LABELS = ["Copy transcript", "Download transcript"] as const;

export function ChatOverflowMenu({
  label = "Chat actions",
  actions,
  transcriptMarkdown,
  transcriptFileName,
  details,
  detailsLabel = "Setup",
}: {
  label?: string;
  actions: ChatOverflowAction[];
  transcriptMarkdown: string;
  transcriptFileName: string;
  details?: ReactNode;
  detailsLabel?: string;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [detailsAnchor, setDetailsAnchor] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState<string>();
  const close = () => setAnchor(null);
  const run = (action: () => void) => {
    close();
    action();
  };

  return <>
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ minWidth: 44, minHeight: 44 }}
      >
        <MoreVertIcon />
      </IconButton>
    </Tooltip>
    <Menu
      anchorEl={anchor}
      open={Boolean(anchor)}
      onClose={close}
      MenuListProps={{ "aria-label": label, dense: true }}
      slotProps={{ paper: { sx: { minWidth: 240, maxWidth: "min(360px, calc(100vw - 24px))" } } }}
    >
      {details ? <MenuItem onClick={() => {
        setDetailsAnchor(anchor);
        close();
      }}>
        <ListItemIcon><TuneOutlinedIcon fontSize="small" /></ListItemIcon>
        <ListItemText>{detailsLabel}</ListItemText>
      </MenuItem> : null}
      {details ? <Divider /> : null}
      {actions.map((action) => <MenuItem
        key={action.label}
        disabled={action.disabled}
        onClick={() => run(action.onSelect)}
        sx={action.destructive ? { color: "error.main" } : undefined}
      >
        {action.icon ? <ListItemIcon sx={action.destructive ? { color: "inherit" } : undefined}>{action.icon}</ListItemIcon> : null}
        <ListItemText>{action.label}</ListItemText>
      </MenuItem>)}
      {actions.length ? <Divider /> : null}
      <MenuItem onClick={() => {
        close();
        void copyText(transcriptMarkdown)
          .then(() => setNotice("Transcript copied"))
          .catch((error) => setNotice(error instanceof Error ? error.message : "Transcript could not be copied"));
      }}>
        <ListItemIcon><ContentCopyOutlinedIcon fontSize="small" /></ListItemIcon>
        <ListItemText>{CHAT_TRANSCRIPT_ACTION_LABELS[0]}</ListItemText>
      </MenuItem>
      <MenuItem onClick={() => run(() => {
        downloadMarkdownTranscript(transcriptMarkdown, transcriptFileName);
        setNotice("Transcript downloaded");
      })}>
        <ListItemIcon><DownloadOutlinedIcon fontSize="small" /></ListItemIcon>
        <ListItemText>{CHAT_TRANSCRIPT_ACTION_LABELS[1]}</ListItemText>
      </MenuItem>
    </Menu>
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
    <Snackbar
      open={Boolean(notice)}
      autoHideDuration={2500}
      onClose={() => setNotice(undefined)}
      message={notice}
    />
  </>;
}
