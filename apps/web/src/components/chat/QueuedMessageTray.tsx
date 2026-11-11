import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import { Button, IconButton, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { QueuedConversationMessageDto } from "@ponderosa/core";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterPaintBackgroundTask } from "../../afterPaintBackgroundTask";
import { capturedSubmissionRunning, readCapturedSubmissions, submissionOutboxEvent, type CapturedSubmission } from "./submissionOutbox";
import { productApiPath } from "../../api/productScope";
import { composerSurfaceWidth } from "./Composer.styles";

function QueuedMessageTrayComponent({ messages, scope, attachmentNamesForMessage, busy, onSteer, onEdit, onDelete }: {
  messages: QueuedConversationMessageDto[];
  scope?: string;
  attachmentNamesForMessage?(message: QueuedConversationMessageDto): string[] | undefined;
  busy?: boolean;
  onSteer(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
  onEdit(message: QueuedConversationMessageDto, text: string): Promise<unknown> | unknown;
  onDelete(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
}): JSX.Element | null {
  const namespace=productApiPath('/api/conversations');
  const identity=useRef<{scope?:string;namespace:string;keys:Map<string,string>}>({scope,namespace,keys:new Map()});
  if(identity.current.scope!==scope||identity.current.namespace!==namespace)identity.current={scope,namespace,keys:new Map()};
  const remember=()=>{
    if(productApiPath('/api/conversations')!==namespace)return;
    for(const item of readCapturedSubmissions(scope).filter(item=>!item.apiNamespace||item.apiNamespace===namespace)){
      const targets=item.pending.request?.recipientAgentIds.length?item.pending.request.recipientAgentIds:[''];
      targets.forEach((target,index)=>{const key=index===0?`capture:${item.pending.idempotencyKey}`:`capture:${item.pending.idempotencyKey}:${target}`;
        if(item.communicationId)identity.current.keys.set(`communication:${item.communicationId}:${target}`,key);
        if(targets.length===1)for(const id of item.acceptedDeliveryIds??[])identity.current.keys.set(id,key);
      });
    }
  };
  // The existing outbox event precedes retirement even when React batches all
  // intermediate renders. Remember presentation anchors, never delivery state.
  const [, refresh] = useState(0);
  useEffect(() => {
    const changed = () => {remember();refresh(value => value + 1);};
    window.addEventListener(submissionOutboxEvent, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(submissionOutboxEvent, changed); window.removeEventListener("storage", changed); };
  }, [scope,namespace]);
  const captured=scope?readCapturedSubmissions(scope).filter(item=>(!item.apiNamespace||item.apiNamespace===namespace)&&(item.action==='queue'||item.pending.request?.runtime.activeRunDelivery==='queue')):[];
  // React keys only: never a second queue, delivery record or dispatch authority.
  remember();
  const keys=identity.current.keys;
  type Row={key:string;message?:QueuedConversationMessageDto;capture?:CapturedSubmission};
  const canonicalRows:Row[]=messages.map(message=>({key:keys.get(message.deliveryId)??keys.get(`communication:${message.communicationEventId}:${message.targetAgentId}`)??keys.get(`communication:${message.communicationEventId}:`)??`delivery:${message.deliveryId}`,message}));
  const pendingRows:Row[]=[];
  for(const item of captured){
    const matches=canonicalRows.filter(row=>item.acceptedDeliveryIds?.includes(row.message!.deliveryId)||Boolean(item.communicationId&&row.message!.communicationEventId===item.communicationId));
    const targets=item.pending.request?.recipientAgentIds.length?item.pending.request.recipientAgentIds:matches.length?matches.map(row=>row.message!.targetAgentId):[''];
    for(const [index,target] of targets.entries()){
      const found=matches.find(row=>row.message!.targetAgentId===target)||(targets.length===1?matches[0]:undefined);
      const key=index===0?`capture:${item.pending.idempotencyKey}`:`capture:${item.pending.idempotencyKey}:${target}`;
      if(found){
        found.key=keys.get(found.message!.deliveryId)??key;keys.set(found.message!.deliveryId,found.key);found.capture=item;
      }else if(item.status!=='accepted'||!item.acceptedDeliveryIds?.length||matches.length===0){pendingRows.push({key,capture:item});}
    }
  }
  const activeIds=new Set(messages.flatMap(message=>[message.deliveryId,`communication:${message.communicationEventId}:${message.targetAgentId}`,`communication:${message.communicationEventId}:`]));
  for(const item of captured){for(const id of item.acceptedDeliveryIds??[])activeIds.add(id);if(item.communicationId)for(const target of item.pending.request?.recipientAgentIds??[''])activeIds.add(`communication:${item.communicationId}:${target}`);}
  for(const id of keys.keys())if(!activeIds.has(id))keys.delete(id);
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
          (Array.from(rootRef.current?.querySelectorAll("[data-delivery-id]")??[]).at(-1)?.contains(event.target as Node) || rootRef.current?.querySelector("[data-queue-row]:last-child")?.contains(event.target as Node))) revealRows();
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
      "& .queued-message-position": { width:"2ch",flexShrink:0,...theme.typography.caption, m: 0, color: "text.secondary", fontVariantNumeric: "tabular-nums" },
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
      {[...canonicalRows.slice(0,shownRows),...pendingRows].map(row=>{
        const message=row.message,item=row.capture,id=item?.pending.idempotencyKey;
        const resolvedNames=message?attachmentNamesForMessage?.(message):undefined;
        const attachmentNames=resolvedNames?.length?resolvedNames:item?.attachmentNames??resolvedNames??[];
        const attachmentCount=message?.attachmentCount??attachmentNames.length;
        const editing=Boolean(message&&editingId===message.deliveryId),inFlight=Boolean(id&&capturedSubmissionRunning(id));
        const rejected=Boolean(item&&!message&&item.status==='failed'),retryable=Boolean(item&&!message&&!inFlight&&['unknown','failed'].includes(item.status));
        const position=message?.position,label=position??'Pending';
        const text=editing?editingText:message?.text??item!.text??'';
        return <div key={row.key} data-queue-row data-delivery-id={message?.deliveryId} data-operation-id={id} className="MuiBox-root queued-message-row">
          <span className="MuiTypography-root MuiTypography-caption queued-message-position" aria-label={position?`Queue Position ${position}`:'Queue Position Pending'}>{position??'…'}</span><SubdirectoryArrowRightIcon aria-hidden sx={{color:'text.disabled',fontSize:16,flex:'0 0 auto'}}/>
          {editing ? <TextField
            value={editingText}
            disabled={busy}
            onChange={(event) => setEditingText(event.target.value)}
            size="small"
            fullWidth
            autoFocus
            multiline
            maxRows={4}
            inputProps={{ "aria-label": `Edit Queued Message ${label}` }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingId(undefined);
              if (event.key === "Enter" && !event.shiftKey && editingText.trim()) {
                event.preventDefault();
                run(() => onEdit(message!, editingText.trim()), () => setEditingId(undefined));
              }
            }}
          /> : <Tooltip disableInteractive title={item?.error??text}><p tabIndex={0} className="MuiTypography-root MuiTypography-body2 MuiTypography-noWrap queued-message-text" aria-label={!message?rejected?"Not Queued":item?.status==="accepted"?"Queue Accepted; Checking Delivery":"Awaiting Queue Confirmation":undefined}>{rejected?"Not Queued · ":""}{text||attachmentNames.join(", ")}</p></Tooltip>}
          {!editing && attachmentCount ? <Tooltip disableInteractive title={attachmentNames.join(", ")||`${attachmentCount} Attachments`}><Typography tabIndex={0} variant="caption" aria-label={`${attachmentCount} Attachments`}>+{attachmentCount}</Typography></Tooltip> : null}
          {editing ? <>
            <Button size="small" disabled={busy || !editingText.trim()} onClick={() => run(() => onEdit(message!, editingText.trim()), () => setEditingId(undefined))}>Save</Button>
            <Button size="small" color="inherit" disabled={busy} onClick={() => setEditingId(undefined)}>Cancel</Button>
          </> : <>
            <Tooltip disableInteractive title={message?'Steer Now':retryable?'Check This Exact Queued Message':'Awaiting Queue Confirmation'}><span><Button size="small" disabled={busy||(!message&&!retryable)} aria-label={message?`Steer Queued Message ${label}`:retryable?'Retry Queued Message':'Steer Queued Message Pending'} startIcon={<SubdirectoryArrowRightIcon fontSize="small"/>} sx={{flexShrink:0,minWidth:64}} onClick={()=>message?run(()=>onSteer(message)):window.dispatchEvent(new CustomEvent('ponderosa-submission-retry',{detail:id}))}>{retryable?'Retry':'Steer'}</Button></span></Tooltip>
            <Tooltip disableInteractive title="Edit Queued Message"><span><IconButton size="small" disabled={busy||!message} aria-label={`Edit Queued Message ${label}`} onClick={()=>{if(message){setEditingId(message.deliveryId);setEditingText(message.text);}}}><EditOutlinedIcon fontSize="small"/></IconButton></span></Tooltip>
            <Tooltip disableInteractive title="Delete Queued Message"><span><IconButton size="small" disabled={busy||(!message&&(!rejected||inFlight||!navigator.locks))} aria-label={message?`Delete Queued Message ${label}`:rejected?'Discard Rejected Message':'Delete Message After Queue Confirmation'} onClick={()=>message?run(()=>onDelete(message)):window.dispatchEvent(new CustomEvent('ponderosa-submission-discard',{detail:id}))}><DeleteOutlineIcon fontSize="small"/></IconButton></span></Tooltip>
          </>}
        </div>;
      })}
    </Stack>
  </Paper>;
}

// Parent runtime hydration does not change queue rows or their actions.
export const QueuedMessageTray = memo(QueuedMessageTrayComponent);
