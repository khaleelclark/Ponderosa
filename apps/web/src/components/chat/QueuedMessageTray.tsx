import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import { Box, Button, IconButton, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import type { QueuedConversationMessageDto } from "@ponderosa/core";
import { useState } from "react";
import { composerSurfaceWidth } from "./Composer.styles";

export function QueuedMessageTray({ messages, agentNameForId, busy, onSteer, onEdit, onDelete }: {
  messages: QueuedConversationMessageDto[];
  agentNameForId?(agentId: string): string;
  busy?: boolean;
  onSteer(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
  onEdit(message: QueuedConversationMessageDto, text: string): Promise<unknown> | unknown;
  onDelete(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
}): JSX.Element | null {
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const run = (
    action: () => Promise<unknown> | unknown,
    onSuccess?: () => void,
  ) => {
    void Promise.resolve().then(action).then(onSuccess).catch(() => {});
  };
  if (messages.length === 0) return null;
  return <Paper
    variant="outlined"
    aria-label="Queued messages"
    sx={{
      width: composerSurfaceWidth,
      minWidth: 0,
      maxWidth: "100%",
      mx: "auto",
      mb: -1,
      pb: 1.25,
      pt: 0.75,
      px: { xs: 1, sm: 1.5 },
      maxHeight: "min(38vh, 280px)",
      overflowY: "auto",
      borderRadius: "16px 16px 8px 8px",
      bgcolor: "background.paper",
      boxShadow: 2,
    }}
  >
    <Stack spacing={0.25}>
      {messages.map((message) => {
        const editing = editingId === message.deliveryId;
        return <Box key={message.deliveryId} sx={{ display: "flex", alignItems: "center", gap: 0.75, minHeight: 40, minWidth: 0 }}>
          <SubdirectoryArrowRightIcon aria-hidden sx={{ color: "text.disabled", fontSize: 20, flex: "0 0 auto" }} />
          {editing ? <TextField
            value={editingText}
            onChange={(event) => setEditingText(event.target.value)}
            size="small"
            fullWidth
            autoFocus
            multiline
            maxRows={4}
            inputProps={{ "aria-label": `Edit queued message ${message.position}` }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingId(undefined);
              if (event.key === "Enter" && !event.shiftKey && editingText.trim()) {
                event.preventDefault();
                run(() => onEdit(message, editingText.trim()), () => setEditingId(undefined));
              }
            }}
          /> : <Tooltip title={message.text}><Typography variant="body1" noWrap sx={{ flex: 1, minWidth: 0 }}>{message.text}</Typography></Tooltip>}
          {!editing && agentNameForId ? <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", md: "block" }, maxWidth: 160 }}>
            {agentNameForId(message.targetAgentId)}
          </Typography> : null}
          {editing ? <>
            <Button size="small" disabled={busy || !editingText.trim()} onClick={() => run(() => onEdit(message, editingText.trim()), () => setEditingId(undefined))}>Save</Button>
            <Button size="small" color="inherit" onClick={() => setEditingId(undefined)}>Cancel</Button>
          </> : <>
            <Button size="small" color="inherit" disabled={busy} startIcon={<SubdirectoryArrowRightIcon />} onClick={() => run(() => onSteer(message))}>Steer</Button>
            <Tooltip title="Edit Queued Message"><span><IconButton size="small" disabled={busy} aria-label={`Edit queued message ${message.position}`} onClick={() => { setEditingId(message.deliveryId); setEditingText(message.text); }}><EditOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Delete Queued Message"><span><IconButton size="small" disabled={busy} aria-label={`Delete queued message ${message.position}`} onClick={() => run(() => onDelete(message))}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
          </>}
        </Box>;
      })}
    </Stack>
  </Paper>;
}
