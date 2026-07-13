import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ReplyIcon from "@mui/icons-material/Reply";
import { Box, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { type ReactNode, useState } from "react";

export function MessageContextMenu({
  children,
  text,
  onReply,
  onOpenAgent,
}: {
  children: ReactNode;
  text: string;
  onReply?(): void;
  onOpenAgent?(): void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<{ left: number; top: number }>();
  const close = () => setAnchor(undefined);

  return (
    <>
      <Box
        onContextMenu={(event) => {
          event.preventDefault();
          setAnchor({ left: event.clientX + 2, top: event.clientY - 6 });
        }}
      >
        {children}
      </Box>
      {anchor ? <Menu
        open={Boolean(anchor)}
        onClose={close}
        anchorReference="anchorPosition"
        anchorPosition={anchor}
        aria-label="Message actions"
      >
        <MenuItem onClick={() => {
          void navigator.clipboard.writeText(text);
          close();
        }}>
          <ListItemIcon><ContentCopyIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Copy message</ListItemText>
        </MenuItem>
        {onReply ? <MenuItem onClick={() => { close(); onReply(); }}>
          <ListItemIcon><ReplyIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Reply</ListItemText>
        </MenuItem> : null}
        {onOpenAgent ? <MenuItem onClick={() => { close(); onOpenAgent(); }}>
          <ListItemIcon><OpenInNewIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Open agent chat</ListItemText>
        </MenuItem> : null}
      </Menu> : null}
    </>
  );
}
