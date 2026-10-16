import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import { Box, Button, IconButton, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import type { QueuedConversationMessageDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import { capturedSubmissionRunning, readCapturedSubmissions, submissionOutboxEvent } from "./submissionOutbox";
import { composerSurfaceWidth } from "./Composer.styles";

export function QueuedMessageTray({ messages, scope, attachmentNamesForMessage, agentNameForId, busy, onSteer, onEdit, onDelete }: {
  messages: QueuedConversationMessageDto[];
  scope?: string;
  attachmentNamesForMessage?(message: QueuedConversationMessageDto): string[] | undefined;
  agentNameForId?(agentId: string): string;
  busy?: boolean;
  onSteer(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
  onEdit(message: QueuedConversationMessageDto, text: string): Promise<unknown> | unknown;
  onDelete(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
}): JSX.Element | null {
  const [, refresh] = useState(0);
  useEffect(() => {
    const changed = () => refresh(value => value + 1);
    window.addEventListener(submissionOutboxEvent, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(submissionOutboxEvent, changed); window.removeEventListener("storage", changed); };
  }, []);
  const canonicalIds = new Set(messages.map(message => message.deliveryId));
  const captured = scope ? readCapturedSubmissions(scope).filter(item =>
    !(item.status === "accepted" && item.acceptedDeliveryIds?.some(id => canonicalIds.has(id))) &&
    (item.action === "queue" || !capturedSubmissionRunning(item.pending.idempotencyKey))) : [];
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const run = (
    action: () => Promise<unknown> | unknown,
    onSuccess?: () => void,
  ) => {
    void Promise.resolve().then(action).then(onSuccess).catch(() => {});
  };
  if (messages.length === 0 && captured.length === 0) return null;
  return <Paper
    variant="outlined"
    aria-label="Queued messages"
    sx={{
      width: composerSurfaceWidth,
      minWidth: 0,
      maxWidth: "100%",
      mx: "auto",
      mb: -1,
      pb: 0.5,
      pt: 0.5,
      px: 0.75,
      maxHeight: "min(30vh, 160px)",
      "& .MuiIconButton-root, & .MuiButton-root": { minHeight: 28, minWidth: 28, p: 0.5 },
      "@media (pointer: coarse)": { "& .MuiIconButton-root, & .MuiButton-root": { minHeight: 44, minWidth: 44 }, "& [data-queue-row]": { minHeight: 44 } },
      overflowY: "auto",
      borderRadius: "16px 16px 8px 8px",
      bgcolor: "background.paper",
      boxShadow: 2,
    }}
  >
    <Stack spacing={0.25}>
      {captured.map(item => {
        const id = item.pending.idempotencyKey;
        const inFlight = capturedSubmissionRunning(id);
        return <Box key={id} data-queue-row data-operation-id={id} sx={{ display: "flex", alignItems: "center", gap: 0.5, minHeight: 30, minWidth: 0 }}>
          <Tooltip title={[item.text, ...item.attachmentNames, item.error].filter(Boolean).join(" · ")}>
            <Typography tabIndex={0} noWrap variant="body2" sx={{ flex: 1, minWidth: 0 }}>{item.text || item.attachmentNames.join(", ")}</Typography>
          </Tooltip>
          <Tooltip title={item.error ?? (inFlight ? "Awaiting acceptance; not confirmed queued." : "Retry reconciles this exact operation.")}><Typography tabIndex={0} variant="caption" color={item.status === "failed" ? "error" : "text.secondary"}>{inFlight ? "Pending" : item.status === "accepted" ? "Saved" : item.status === "failed" ? "Failed" : "Unconfirmed"}</Typography></Tooltip>
          {item.attachmentNames.length ? <Typography variant="caption" aria-label={`${item.attachmentNames.length} attachments`}>+{item.attachmentNames.length}</Typography> : null}
          <Button size="small" disabled={inFlight} onClick={() => window.dispatchEvent(new CustomEvent("ponderosa-submission-retry", { detail: id }))}>Retry</Button>
          {item.status === "failed" ? <Tooltip title="Discard definitely rejected input"><span><IconButton aria-label="Discard rejected message" disabled={inFlight || !navigator.locks} onClick={() => window.dispatchEvent(new CustomEvent("ponderosa-submission-discard", { detail: id }))}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip> : null}
        </Box>;
      })}
      {messages.map((message) => {
        const attachmentNames = attachmentNamesForMessage?.(message) ?? [];
        const editing = editingId === message.deliveryId;
        return <Box key={message.deliveryId} data-queue-row sx={{ display: "flex", alignItems: "center", gap: 0.75, minHeight: 30, minWidth: 0 }}>
          <Typography variant="caption" aria-label={message.position ? `Queue position ${message.position}` : "Queue position pending"} sx={{ fontVariantNumeric: "tabular-nums" }}>{message.position ?? "…"}</Typography><SubdirectoryArrowRightIcon aria-hidden sx={{ color: "text.disabled", fontSize: 16, flex: "0 0 auto" }} />
          {editing ? <TextField
            value={editingText}
            onChange={(event) => setEditingText(event.target.value)}
            size="small"
            fullWidth
            autoFocus
            multiline
            maxRows={4}
            inputProps={{ "aria-label": `Edit queued message ${message.position ?? "pending"}` }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingId(undefined);
              if (event.key === "Enter" && !event.shiftKey && editingText.trim()) {
                event.preventDefault();
                run(() => onEdit(message, editingText.trim()), () => setEditingId(undefined));
              }
            }}
          /> : <Tooltip title={message.text}><Typography tabIndex={0} variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>{message.text}</Typography></Tooltip>}
          {!editing && attachmentNames.length ? <Tooltip title={attachmentNames.join(", ")}><Typography tabIndex={0} variant="caption" aria-label={`${attachmentNames.length} attachments`}>+{attachmentNames.length}</Typography></Tooltip> : null}
          {!editing && agentNameForId ? <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", md: "block" }, maxWidth: 160 }}>
            {agentNameForId(message.targetAgentId)}
          </Typography> : null}
          {editing ? <>
            <Button size="small" disabled={busy || !editingText.trim()} onClick={() => run(() => onEdit(message, editingText.trim()), () => setEditingId(undefined))}>Save</Button>
            <Button size="small" color="inherit" onClick={() => setEditingId(undefined)}>Cancel</Button>
          </> : <>
            <Tooltip title="Steer now"><span><IconButton size="small" disabled={busy} aria-label={`Steer queued message ${message.position ?? "pending"}`} onClick={() => run(() => onSteer(message))}><SubdirectoryArrowRightIcon fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Edit Queued Message"><span><IconButton size="small" disabled={busy} aria-label={`Edit queued message ${message.position ?? "pending"}`} onClick={() => { setEditingId(message.deliveryId); setEditingText(message.text); }}><EditOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Delete Queued Message"><span><IconButton size="small" disabled={busy} aria-label={`Delete queued message ${message.position ?? "pending"}`} onClick={() => run(() => onDelete(message))}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
          </>}
        </Box>;
      })}
    </Stack>
  </Paper>;
}
