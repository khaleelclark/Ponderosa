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
  Snackbar,
  Tooltip,
} from "@mui/material";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";
import { downloadMarkdownTranscript } from "../chatTranscript";
import { useMobileWorkspaceActionsRegistry } from "./MobileWorkspaceActionsContext";

export interface ChatOverflowAction {
  label: string;
  onSelect(): void;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}

const CHAT_EXPORT_ACTION_LABELS = ["Copy", "Download", "Chat Transcript"] as const;

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
  const [notice, setNotice] = useState<string>();
  const mobileWorkspaceActionsRegistry = useMobileWorkspaceActionsRegistry();
  const mobileWorkspaceActionsOwner = useRef(Symbol("mobile-workspace-actions"));
  const close = () => setAnchor(null);
  const run = (action: () => void) => {
    close();
    action();
  };
  const mobileWorkspaceActions = useRef({
    label: "Current Workspace",
    details: details ? {
      label: detailsLabel,
      icon: <TuneOutlinedIcon fontSize="small" />,
      onSelect: (mobileAnchor: HTMLElement) => setDetailsAnchor(mobileAnchor),
    } : undefined,
    actions: actions.map(action => ({
      ...action,
      onSelect: () => action.onSelect(),
    })),
    copy: showExports ? {
      label: CHAT_EXPORT_ACTION_LABELS[0],
      icon: <ContentCopyOutlinedIcon fontSize="small" />,
      onSelect: (mobileAnchor: HTMLElement) =>
        setExportMenu({ kind: "copy", anchor: mobileAnchor }),
    } : undefined,
    download: showExports ? {
      label: CHAT_EXPORT_ACTION_LABELS[1],
      icon: <DownloadOutlinedIcon fontSize="small" />,
      onSelect: (mobileAnchor: HTMLElement) =>
        setExportMenu({ kind: "download", anchor: mobileAnchor }),
    } : undefined,
  });
  mobileWorkspaceActions.current = {
    label: "Current Workspace",
    details: details ? {
      label: detailsLabel,
      icon: <TuneOutlinedIcon fontSize="small" />,
      onSelect: (mobileAnchor: HTMLElement) => setDetailsAnchor(mobileAnchor),
    } : undefined,
    actions: actions.map(action => ({
      ...action,
      onSelect: () => action.onSelect(),
    })),
    copy: showExports ? {
      label: CHAT_EXPORT_ACTION_LABELS[0],
      icon: <ContentCopyOutlinedIcon fontSize="small" />,
      onSelect: (mobileAnchor: HTMLElement) =>
        setExportMenu({ kind: "copy", anchor: mobileAnchor }),
    } : undefined,
    download: showExports ? {
      label: CHAT_EXPORT_ACTION_LABELS[1],
      icon: <DownloadOutlinedIcon fontSize="small" />,
      onSelect: (mobileAnchor: HTMLElement) =>
        setExportMenu({ kind: "download", anchor: mobileAnchor }),
    } : undefined,
  };
  useLayoutEffect(() => {
    if (!mobileWorkspaceActionsRegistry) return;
    const registration = {
      owner: mobileWorkspaceActionsOwner.current,
      getActions: () => mobileWorkspaceActions.current,
    };
    mobileWorkspaceActionsRegistry.current = registration;
    return () => {
      if (
        mobileWorkspaceActionsRegistry.current?.owner ===
        mobileWorkspaceActionsOwner.current
      ) {
        mobileWorkspaceActionsRegistry.current = undefined;
      }
    };
  }, [mobileWorkspaceActionsRegistry]);

  return <>
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ display: { xs: "none", md: "inline-flex" } }}
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
      {actions.length && showExports ? <Divider /> : null}
      {showExports ? <MenuItem onClick={() => {
        if (anchor) setExportMenu({ kind: "copy", anchor });
        close();
      }}>
        <ListItemIcon><ContentCopyOutlinedIcon fontSize="small" /></ListItemIcon>
        <ListItemText>{CHAT_EXPORT_ACTION_LABELS[0]}</ListItemText>
        <ChevronRightIcon fontSize="small" />
      </MenuItem> : null}
      {showExports ? <MenuItem onClick={() => {
        if (anchor) setExportMenu({ kind: "download", anchor });
        close();
      }}>
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
      slotProps={{ paper: { sx: { minWidth: 260, maxWidth: "min(360px, calc(100vw - 24px))" } } }}
    >
      <MenuList dense aria-label={`${exportMenu?.kind === "download" ? "Download" : "Copy"} options`}>
        {(exportMenu?.kind === "download" ? downloadActions : copyActions).map((action) => <MenuItem
          key={action.label}
          disabled={action.disabled}
          onClick={() => {
            setExportMenu(undefined);
            action.onSelect();
          }}
        >
          {action.icon ? <ListItemIcon>{action.icon}</ListItemIcon> : null}
          <ListItemText>{action.label}</ListItemText>
        </MenuItem>)}
        {(exportMenu?.kind === "download" ? downloadActions : copyActions).length ? <Divider /> : null}
        <MenuItem onClick={() => {
          const kind = exportMenu?.kind;
          setExportMenu(undefined);
          if (kind === "download") {
            downloadMarkdownTranscript(transcriptMarkdown, transcriptFileName);
            setNotice("Chat transcript downloaded");
            return;
          }
          void copyText(transcriptMarkdown)
            .then(() => setNotice("Chat transcript copied"))
            .catch((error) => setNotice(error instanceof Error ? error.message : "Chat transcript could not be copied"));
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
    <Snackbar
      open={Boolean(notice)}
      autoHideDuration={2500}
      onClose={() => setNotice(undefined)}
      message={notice}
    />
  </>;
}
