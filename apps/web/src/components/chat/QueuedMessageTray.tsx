import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import { Box, Button, IconButton, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { QueuedConversationMessageDto } from "@ponderosa/core";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterPaintBackgroundTask } from "../../afterPaintBackgroundTask";
import { capturedSubmissionRunning, readCapturedSubmissions, submissionOutboxEvent } from "./submissionOutbox";
import { composerSurfaceWidth } from "./Composer.styles";

function QueuedMessageTrayComponent({ messages, scope, attachmentNamesForMessage, busy, onSteer, onEdit, onDelete, queueReviewHref }: {
  messages: QueuedConversationMessageDto[];
  scope?: string;
  queueReviewHref?: string;
  attachmentNamesForMessage?(message: QueuedConversationMessageDto): string[] | undefined;
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
    (item.action === "queue" || item.pending.request?.runtime.activeRunDelivery === "queue")) : [];
  // As in Main history, only the first cold mount is staged. Eight rows fill
  // this at-most-160px tray; subsequent rows append without moving its controls.
  const rootRef = useRef<HTMLDivElement>(null);
  const initialIds = useRef<readonly string[]>();
  if (initialIds.current === undefined && messages.length) initialIds.current = messages.map(message => message.deliveryId);
  const sequenceChanged = initialIds.current !== undefined &&
    (initialIds.current.length !== messages.length || initialIds.current.some((id, index) => id !== messages[index]?.deliveryId));
  const [mountedRows, setMountedRows] = useState(8);
  const shownRows = sequenceChanged ? messages.length : Math.min(mountedRows, messages.length);
  const loading = shownRows < messages.length;
  useLayoutEffect(() => {
    if (sequenceChanged) setMountedRows(Infinity);
  }, [sequenceChanged]);
  const revealRows = () => { if (loading) flushSync(() => setMountedRows(Infinity)); };
  useEffect(() => {
    if (!loading) return;
    const cancelBatch = afterPaintBackgroundTask(() => setMountedRows(count => count + 8));
    const findOrSelect = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const target = event.target, editable = target instanceof HTMLElement &&
        (target.isContentEditable || Boolean(target.closest("input, textarea, select")));
      if (event.key.toLowerCase() === "f" || event.key.toLowerCase() === "a" && !editable) revealRows();
    };
    const selected = () => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && rootRef.current?.contains(selection.anchorNode)) revealRows();
    };
    document.addEventListener("keydown", findOrSelect, true);
    document.addEventListener("selectionchange", selected);
    window.addEventListener("beforeprint", revealRows);
    return () => {
      cancelBatch();
      document.removeEventListener("keydown", findOrSelect, true);
      document.removeEventListener("selectionchange", selected);
      window.removeEventListener("beforeprint", revealRows);
    };
  }, [loading, mountedRows, messages.length]);
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
    ref={rootRef}
    variant="outlined"
    aria-label="Queued Messages"
    aria-busy={loading || undefined}
    onScroll={revealRows}
    onKeyDownCapture={event => {
      if (loading && event.key === "Tab" && !event.shiftKey &&
          rootRef.current?.querySelector("[data-queue-row]:last-child")?.contains(event.target as Node)) revealRows();
    }}
    sx={theme => ({
      width: Object.fromEntries(Object.entries(composerSurfaceWidth).map(([breakpoint, width]) =>
        [breakpoint, `calc(${width} - ${breakpoint === "xs" ? 8 : 16}px)`])),
      position: "relative",
      zIndex: 2,
      minWidth: 0,
      maxWidth: "100%",
      mx: "auto",
      mb: -1,
      pb: 0.5,
      pt: 0.5,
      px: 0.75,
      maxHeight: "min(30vh, 160px)",
      "& .MuiIconButton-root, & .MuiButton-root": { minHeight: 28, minWidth: 28, p: 0.5 },
      "& .queued-message-row": { display: "flex", alignItems: "center", gap: 0.75, minHeight: 30, minWidth: 0 },
      "& [data-queue-row] + [data-queue-row]": { borderTop: 1, borderColor: alpha(theme.palette.divider, 0.4) },
      "& .queued-message-position": { ...theme.typography.caption, m: 0, color: "text.secondary", fontVariantNumeric: "tabular-nums" },
      "& .queued-message-text": { ...theme.typography.body2, m: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      "@media (pointer: coarse)": { "& .MuiIconButton-root, & .MuiButton-root": { minHeight: 44, minWidth: 44 }, "& [data-queue-row]": { minHeight: 44 } },
      overflowY: "auto",
      borderRadius: "14px 14px 8px 8px",
      borderColor: alpha(theme.palette.divider, 0.55),
      // Reserve the overlap outside the scrollport, including while mid-scroll.
      borderBottomWidth: 12,
      borderBottomColor: "transparent",
      bgcolor: `var(--ponderosa-surface-secondary, ${theme.palette.background.paper})`,
      boxShadow: "none",
    })}
  >
    <Stack spacing={0.25}>
      {captured.map(item => {
        const id = item.pending.idempotencyKey;
        const inFlight = capturedSubmissionRunning(id);
        return <Box key={id} data-queue-row data-operation-id={id} sx={{ display: "flex", alignItems: "center", gap: 0.5, minHeight: 30, minWidth: 0 }}>
          <Tooltip title={[item.text, ...item.attachmentNames, item.error].filter(Boolean).join(" · ")}>
            <Typography tabIndex={0} noWrap variant="body2" sx={{ flex: 1, minWidth: 0 }}>{item.text || item.attachmentNames.join(", ")}</Typography>
          </Tooltip>
          {item.error ? <Box component="details" sx={{minWidth:0,fontSize:".75rem","& summary":{cursor:"pointer"}}}><summary>{inFlight ? "Pending" : item.status === "accepted" ? "Saved" : item.status === "failed" ? "Failed" : "Unconfirmed"} · Details</summary><Box sx={{maxWidth:320,maxHeight:160,overflowY:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{item.error}</Box></Box> : <Tooltip title={inFlight ? "Awaiting acceptance; not confirmed queued." : "Retry reconciles this exact operation."}><Typography tabIndex={0} variant="caption">{inFlight ? "Pending" : item.status === "accepted" ? "Saved" : item.status === "failed" ? "Failed" : "Unconfirmed"}</Typography></Tooltip>}
          {item.attachmentNames.length ? <Typography variant="caption" aria-label={`${item.attachmentNames.length} Attachments`}>+{item.attachmentNames.length}</Typography> : null}
          {queueReviewHref && (item.action === "queue" || item.pending.request?.runtime.activeRunDelivery === "queue")
            ? <Button size="small" href={queueReviewHref}>Review In Agent Chat</Button>
            : <Button size="small" disabled={inFlight} onClick={() => window.dispatchEvent(new CustomEvent("ponderosa-submission-retry", { detail: id }))}>Retry</Button>}
          {item.status === "failed" ? <Tooltip title="Discard Definitely Rejected Input"><span><IconButton aria-label="Discard Rejected Message" disabled={inFlight || !navigator.locks} onClick={() => window.dispatchEvent(new CustomEvent("ponderosa-submission-discard", { detail: id }))}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip> : null}
        </Box>;
      })}
      {messages.slice(0, shownRows).map((message) => {
        const attachmentNames = attachmentNamesForMessage?.(message) ?? [];
        const editing = editingId === message.deliveryId;
        return <div key={message.deliveryId} data-queue-row className="MuiBox-root queued-message-row">
          <span className="MuiTypography-root MuiTypography-caption queued-message-position" aria-label={message.position ? `Queue Position ${message.position}` : "Queue Position Pending"}>{message.position ?? "…"}</span><SubdirectoryArrowRightIcon aria-hidden sx={{ color: "text.disabled", fontSize: 16, flex: "0 0 auto" }} />
          {editing ? <TextField
            value={editingText}
            disabled={busy}
            onChange={(event) => setEditingText(event.target.value)}
            size="small"
            fullWidth
            autoFocus
            multiline
            maxRows={4}
            inputProps={{ "aria-label": `Edit Queued Message ${message.position ?? "pending"}` }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingId(undefined);
              if (event.key === "Enter" && !event.shiftKey && editingText.trim()) {
                event.preventDefault();
                run(() => onEdit(message, editingText.trim()), () => setEditingId(undefined));
              }
            }}
          /> : <Tooltip title={message.text}><p tabIndex={0} className="MuiTypography-root MuiTypography-body2 MuiTypography-noWrap queued-message-text">{message.text}</p></Tooltip>}
          {!editing && attachmentNames.length ? <Tooltip title={attachmentNames.join(", ")}><Typography tabIndex={0} variant="caption" aria-label={`${attachmentNames.length} Attachments`}>+{attachmentNames.length}</Typography></Tooltip> : null}
          {editing ? <>
            <Button size="small" disabled={busy || !editingText.trim()} onClick={() => run(() => onEdit(message, editingText.trim()), () => setEditingId(undefined))}>Save</Button>
            <Button size="small" color="inherit" disabled={busy} onClick={() => setEditingId(undefined)}>Cancel</Button>
          </> : <>
            <Tooltip disableInteractive title="Steer Now"><span><Button size="small" disabled={busy} aria-label={`Steer Queued Message ${message.position ?? "Pending"}`} startIcon={<SubdirectoryArrowRightIcon fontSize="small" />} sx={{ flexShrink: 0 }} onClick={() => run(() => onSteer(message))}>Steer</Button></span></Tooltip>
            <Tooltip disableInteractive title="Edit Queued Message"><span><IconButton size="small" disabled={busy} aria-label={`Edit Queued Message ${message.position ?? "Pending"}`} onClick={() => { setEditingId(message.deliveryId); setEditingText(message.text); }}><EditOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip disableInteractive title="Delete Queued Message"><span><IconButton size="small" disabled={busy} aria-label={`Delete Queued Message ${message.position ?? "Pending"}`} onClick={() => run(() => onDelete(message))}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
          </>}
        </div>;
      })}
    </Stack>
  </Paper>;
}

// Parent runtime hydration does not change queue rows or their actions.
export const QueuedMessageTray = memo(QueuedMessageTrayComponent);
