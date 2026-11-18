import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import {CircularProgress,ListItemIcon,Menu,MenuItem} from "@mui/material";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import PersonAddAltOutlinedIcon from "@mui/icons-material/PersonAddAltOutlined";
import ScheduleSendOutlinedIcon from "@mui/icons-material/ScheduleSendOutlined";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import {
  Button,
  Box,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ComposerAttachment } from "./ComposerAttachment";
import type { DraftUploadStatus } from "./ComposerAttachment";
import type { ComposerProps } from "./Composer.types";

interface ComposerDestinationBarProps {
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
}

export function ComposerDestinationBar({
  destinationError,
  destinationMode: _destinationMode,
}: ComposerDestinationBarProps): JSX.Element | null {
  return destinationError ? (
    <Typography
      variant="caption"
      color="error.main"
      sx={{ display: "block", px: 0.25, pb: 0.75 }}
    >
      {destinationError}
    </Typography>
  ) : null;
}

interface ComposerProjectDestinationActionProps {
  disabled: boolean;
  newAgentSelected: boolean;
  toggleNewAgent(): void;
  replyDestination?: string;
}

export function ComposerProjectDestinationAction({
  disabled,
  newAgentSelected,
  toggleNewAgent,
  replyDestination,
}: ComposerProjectDestinationActionProps): JSX.Element {
  if (replyDestination) {
    return (
      <Tooltip title="Switch To A New Agent">
        <Button
          disabled={disabled}
          size="small"
          variant="text"
          color="primary"
          onClick={toggleNewAgent}
          aria-label={`Reply To ${replyDestination}; switch to a new Agent`}
          sx={{
            minWidth: { xs: 58, md: 64 },
            gap: { xs: 0.5, md: 0 },
            whiteSpace: "nowrap",
            minHeight: { xs: 44, sm: 34 },
            "@media (pointer: coarse)": { minHeight: 44 },
            "@media (max-width: 340px)": { minWidth: 44, px: 0, gap: 0 },
          }}
        >
          <PersonAddAltOutlinedIcon sx={{ display: { xs: "block", md: "none" } }} />
          <Box component="span" sx={{ display: { xs: "inline", md: "none" }, "@media (max-width: 340px)": { display: "none" } }}>New</Box>
          <Box component="span" sx={{ display: { xs: "none", md: "inline" } }}>Reply To {replyDestination}</Box>
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button
      disabled={disabled}
      size="small"
      variant={newAgentSelected ? "contained" : "text"}
      color={newAgentSelected ? "primary" : "inherit"}
      startIcon={<PersonAddAltOutlinedIcon />}
      aria-pressed={newAgentSelected}
      aria-label="New Agent — Send This Message To Create One"
      title="Send Your Message To Create A New Agent In This Chat"
      onClick={toggleNewAgent}
      sx={{
        minWidth: { xs: 58, md: 64 },
        px: { xs: 0.75, md: 1 },
        "& .MuiButton-startIcon": { mr: { xs: 0.5, md: 1 }, ml: 0 },
        whiteSpace: "nowrap",
        minHeight: { xs: 44, sm: 34 },
        "@media (pointer: coarse)": { minHeight: 44 },
        "@media (max-width: 340px)": { minWidth: 44, px: 0, "& .MuiButton-startIcon": { mr: 0 } },
      }}
    >
      <Box component="span" sx={{ display: { xs: "inline", md: "none" }, "@media (max-width: 340px)": { display: "none" } }}>New</Box>
      <Box component="span" sx={{ display: { xs: "none", md: "inline" } }}>New Agent</Box>
    </Button>
  );
}

interface ComposerAttachmentListProps {
  disabled: boolean;
  draftUploadStates: Map<
    File,
    { status: DraftUploadStatus; error?: string }
  >;
  files: File[];
  removeFile(index: number): void;
  retryDraftUpload(file: File): void;
}

const composerAttachmentKeys = new WeakMap<File, string>();
let nextComposerAttachmentKey = 0;

function composerAttachmentKey(file: File): string {
  const existing = composerAttachmentKeys.get(file);
  if (existing) return existing;
  nextComposerAttachmentKey += 1;
  const key = `composer-attachment-${nextComposerAttachmentKey}`;
  composerAttachmentKeys.set(file, key);
  return key;
}

function ComposerAttachmentListView({
  disabled,
  draftUploadStates,
  files,
  removeFile,
  retryDraftUpload,
}: ComposerAttachmentListProps): JSX.Element | null {
  return files.length > 0 ? (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      flexWrap="wrap"
      sx={{ mb: 1 }}
    >
      {files.map((file, index) => {
        const upload = draftUploadStates.get(file);
        return (
          <ComposerAttachment
            key={composerAttachmentKey(file)}
            file={file}
            status={upload?.status}
            error={upload?.error}
            onRetry={() => retryDraftUpload(file)}
            onRemove={() => removeFile(index)}
            disabled={disabled}
          />
        );
      })}
    </Stack>
  ) : null;
}

/** Keep mounted image previews untouched while only composer text changes. */
export const ComposerAttachmentList = memo(ComposerAttachmentListView);

interface ComposerMentionStatusProps {
  destinationMode: ComposerProps["destinationMode"];
  mentionedBusyHandles: string[];
  mentionedHandles: string[];
}

export function ComposerMentionStatus({
  destinationMode,
  mentionedBusyHandles,
  mentionedHandles,
}: ComposerMentionStatusProps): JSX.Element | null {
  return mentionedHandles.length > 0 &&
    destinationMode !== "project-chat" &&
    destinationMode !== "target-required" ? (
    <Typography
      variant="caption"
      color={
        mentionedBusyHandles.length > 0
          ? "warning.main"
          : "text.secondary"
      }
    >
      {mentionedHandles.some(
        handle => handle.toLocaleLowerCase() === "broadcast",
      )
        ? "Adding durable shared context without starting an agent"
        : mentionedBusyHandles.length > 0
          ? `${mentionedBusyHandles.map(handle => `#${handle}`).join(", ")} ${mentionedBusyHandles.length > 1 ? "are" : "is"} working — your message will steer the active turn when supported.`
          : mentionedHandles.some(
                handle => handle.toLocaleLowerCase() === "everyone",
              )
            ? "Notifying every active agent in this conversation"
            : `Messaging ${mentionedHandles.map(handle => `#${handle}`).join(", ")}`}
    </Typography>
  ) : null;
}

interface ComposerSendActionsProps {
  runControl?: ComposerProps["runControl"];
  steeringOnly?: boolean;
  allowSendWhileRunning: boolean;
  canCancel: boolean;
  cancelPending: boolean;
  canSend: boolean;
  compact: boolean;
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
  mentionedBusyHandles: string[];
  onCancel: ComposerProps["onCancel"];
  queue(): void;
  recipientRequiredMessage: string | undefined;
  sendUnavailableReason: string | undefined;
  send(): void;
  showQueue: boolean;
  steer(): void;
  targetRequiredRecipientTagged: boolean;
}

export function ComposerSendActions({
  runControl,
  steeringOnly = false,
  allowSendWhileRunning,
  canCancel,
  cancelPending,
  canSend,
  compact,
  destinationError,
  destinationMode,
  mentionedBusyHandles,
  onCancel,
  queue,
  recipientRequiredMessage,
  sendUnavailableReason,
  send,
  showQueue,
  steer,
  targetRequiredRecipientTagged,
}: ComposerSendActionsProps): JSX.Element {
  const [runMenu,setRunMenu]=useState<HTMLElement|null>(null);
  const [sendMenu,setSendMenu]=useState<HTMLElement|null>(null);
  const longPress=useRef<number>(),suppressClick=useRef(false);
  // A Run that ends, or a draft that can no longer queue, closes its menu without acting.
  useEffect(()=>{if(!canCancel)setRunMenu(null)},[canCancel]);
  useEffect(()=>{if(!showQueue||!canSend)setSendMenu(null)},[showQueue,canSend]);
  useEffect(()=>()=>window.clearTimeout(longPress.current),[]);
  const runBusy=cancelPending||Boolean(runControl?.pending);
  const clearPress=()=>window.clearTimeout(longPress.current);
  // Queue lives behind the Send/Steer button's context menu. Opening it never submits.
  const queueMenuProps=(primary:()=>void)=>({
    onClick:()=>{if(suppressClick.current){suppressClick.current=false;return;}primary();},
    ...(showQueue?{
      "aria-haspopup":"menu" as const,
      onContextMenu:(event:MouseEvent<HTMLElement>)=>{event.preventDefault();if(canSend)setSendMenu(event.currentTarget);},
      onKeyDown:(event:KeyboardEvent<HTMLElement>)=>{if(event.key==="ContextMenu"||event.key==="F10"&&event.shiftKey){event.preventDefault();if(canSend)setSendMenu(event.currentTarget);}},
      onPointerDown:(event:PointerEvent<HTMLElement>)=>{suppressClick.current=false;if(event.pointerType!=="touch"||!canSend)return;const target=event.currentTarget;clearPress();longPress.current=window.setTimeout(()=>{suppressClick.current=true;setSendMenu(target);},500);},
      onPointerUp:clearPress,onPointerCancel:clearPress,onPointerLeave:clearPress,
    }:{}),
  });
  return (
    <>
      {canCancel ? <>
        <Tooltip disableInteractive title={cancelPending?(runControl?"Stopping…":"Cancelling…"):runControl?.pending?"Waiting…":"Run Controls"}>
          <span><IconButton aria-label="Run Controls" aria-haspopup="menu" aria-expanded={runMenu?"true":undefined} disabled={runBusy} onClick={event=>setRunMenu(event.currentTarget)} sx={{width:44,height:44}}>
            {runBusy?<CircularProgress size={20}/>:runControl?.paused?<PlayCircleOutlineIcon/>:<PauseCircleOutlineIcon/>}
          </IconButton></span>
        </Tooltip>
        <Menu anchorEl={runMenu} open={Boolean(runMenu)} onClose={()=>setRunMenu(null)} MenuListProps={{"aria-label":"Run Controls"}}>
          {runControl?<MenuItem disabled={runBusy||runControl.resumeDisabled} onClick={()=>{setRunMenu(null);runControl.onPauseResume();}}>
            <ListItemIcon>{runControl.paused?<PlayArrowIcon fontSize="small"/>:<PauseIcon fontSize="small"/>}</ListItemIcon>
            {runControl.paused?(runControl.resumeDisabled?"Resume Unavailable While Access Is Restricted":"Resume"):"Pause"}
          </MenuItem>:null}
          <MenuItem disabled={runBusy} onClick={()=>{setRunMenu(null);onCancel?.();}} sx={{color:"error.main"}}>
            <ListItemIcon><StopCircleIcon fontSize="small" color="error"/></ListItemIcon>{runControl?"Stop":"Cancel Run"}
          </MenuItem>
        </Menu>
      </> : null}
      {showQueue ? <Menu anchorEl={sendMenu} open={Boolean(sendMenu)} onClose={()=>setSendMenu(null)} MenuListProps={{"aria-label":"Send Options"}}>
        <MenuItem disabled={!canSend} onClick={()=>{setSendMenu(null);queue();}}>
          <ListItemIcon><ScheduleSendOutlinedIcon fontSize="small"/></ListItemIcon>Queue After Active Response
        </MenuItem>
      </Menu> : null}
      {showQueue ? (
        <Tooltip disableInteractive title="Steer The Active Response">
          <span>
            {compact ? (
              <IconButton
                color="primary"
                disabled={!canSend}
                {...queueMenuProps(steer)}
                aria-label="Steer Active Response"
                sx={{width:44,height:44}}
              >
                <ArrowUpwardIcon />
              </IconButton>
            ) : (
              <Button
                size="small"
                variant="contained"
                disabled={!canSend}
                {...queueMenuProps(steer)}
                aria-label="Steer Active Response"
                endIcon={<ArrowUpwardIcon sx={{ fontSize: 18 }} />}
                sx={{ minHeight: 40, px: 1.5, borderRadius: 999, boxShadow: "none" }}
              >
                Steer
              </Button>
            )}
          </span>
        </Tooltip>
      ) : (!canCancel || allowSendWhileRunning) ? (
        <Tooltip disableInteractive
          title={
            !canSend &&
            (destinationError ||
              sendUnavailableReason ||
              (destinationMode === "target-required" &&
                !targetRequiredRecipientTagged))
              ? (destinationError ??
                sendUnavailableReason ??
                recipientRequiredMessage ??
                "Choose at least one Agent recipient.")
              : "Send"
          }
        >
          <span>
            <IconButton
              color="primary"
              disabled={!canSend}
              onClick={send}
              sx={{width:44,height:44}}
              aria-label={!steeringOnly && mentionedBusyHandles.length > 0
                ? "Queue Message"
                : "Send Message"}
            >
              <ArrowUpwardIcon />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
    </>
  );
}
