import {createPortal,flushSync} from 'react-dom';
import {ConversationChromeContext} from '../ConversationChromeContext';
import {VoiceMessageRecorder} from './VoiceMessageRecorder';
import {isOutputAppPath} from '../../api/productScope';
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import PhoneIcon from "@mui/icons-material/Phone";
import MicNoneIcon from "@mui/icons-material/MicNone";
import StopIcon from "@mui/icons-material/Stop";
import { Box, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, Typography } from "@mui/material";
import { useContext, useEffect, useId, useRef, useState } from "react";
import {
  speechControlGroupSx,
  speechStatusSx,
  visuallyHiddenSpeechStatusSx,
} from "./speechStyles";
import { useWorkspaceReadOnly } from "../WorkspaceReadOnlyContext";
import { useDictation } from "./useDictation";
import { VoiceConversation, type VoiceConversationContext } from "./VoiceConversation";

export function DictationControls({
  disabled: suppliedDisabled,
  voiceContext,
  onFinalTranscript,
  onSettlingChange,
  onActiveChange,
  onVoiceAttachment,
  maxRecordingBytes=80*1024*1024,
  recordingContainer,
  inlineVoiceOptions = false,
}: {
  disabled: boolean;
  voiceContext?: VoiceConversationContext;
  onFinalTranscript(transcript: string): void;
  onSettlingChange(settling: boolean): void;
  onActiveChange?(active: boolean): void;
  onVoiceAttachment?(file:File):string|undefined;
  maxRecordingBytes?:number;
  recordingContainer?:HTMLElement|null;
  inlineVoiceOptions?:boolean;
}): JSX.Element {
  const disabled = useWorkspaceReadOnly() || suppliedDisabled;
  const callActionsHost=useContext(ConversationChromeContext)?.callActionsHost;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const recordingButtonRef=useRef<HTMLButtonElement|null>(null),restoreRecordingFocus=useRef(false);
  const callInvoker=useRef<{node:HTMLButtonElement;owner:string}>();
  const restoreCallFocus=useRef<{node:HTMLButtonElement;owner:string}>();
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const callOwner = JSON.stringify([voiceContext?.projectId, voiceContext?.conversationId, voiceContext?.selectedAgentId, voiceContext?.lockAgent]);
  const [openedCallOwner, setOpenedCallOwner] = useState<string>();
  const callOpen = openedCallOwner === callOwner;
  const [openedRecordingOwner,setOpenedRecordingOwner]=useState<string>();
  const recordingOpen=Boolean(recordingContainer)&&openedRecordingOwner===callOwner;
  useEffect(()=>{if(!recordingContainer)setOpenedRecordingOwner(undefined);},[recordingContainer]);
  useEffect(()=>{if(!recordingOpen&&restoreRecordingFocus.current){restoreRecordingFocus.current=false;const focused=document.activeElement;if(focused===document.body||recordingContainer?.contains(focused))(recordingButtonRef.current??buttonRef.current)?.focus({preventScroll:true});}},[recordingOpen,recordingContainer]);
  useEffect(() => { setOpenedCallOwner(undefined);setOpenedRecordingOwner(undefined); }, [callOwner]);
  useEffect(() => {
    if (disabled) { setAnchor(null); setOpenedCallOwner(undefined);setOpenedRecordingOwner(undefined); }
  }, [disabled]);
  useEffect(() => {
    if(callOpen || !restoreCallFocus.current)return;
    const target=restoreCallFocus.current;restoreCallFocus.current=undefined;
    const focused=document.activeElement;
    if(target.owner===callOwner && target.node.isConnected &&
        (focused===document.body || !focused?.isConnected || focused===target.node)) target.node.focus({preventScroll:true});
  }, [callOpen,callOwner]);
  const dictation = useDictation(
    onFinalTranscript,
    onSettlingChange,
    rootRef,
  );
  const active = ["starting", "listening", "pausing", "stopping"].includes(
    dictation.status,
  );
  const paused = dictation.status === "paused";
  useEffect(() => {
    onActiveChange?.(active || paused || recordingOpen);
    return()=>onActiveChange?.(false);
  }, [active, paused, recordingOpen, onActiveChange]);
  const busy = dictation.status === "pausing" || dictation.status === "stopping";
  const canStopForDisabled =
    dictation.status === "starting" ||
    dictation.status === "listening" ||
    paused;

  useEffect(() => {
    if (disabled && canStopForDisabled) dictation.stop();
  }, [canStopForDisabled, dictation.stop, disabled]);

  const unavailable = dictation.unavailableReason;
  const primaryLabel = unavailable
    ? unavailable
    : dictation.status === "listening" || dictation.status === "starting"
      ? "Pause voice dictation"
      : paused
        ? "Resume voice dictation"
        : "Start voice dictation";
  const statusLabel = dictation.error
    ? dictation.error
    : dictation.status === "starting"
      ? "Starting dictation…"
      : dictation.status === "listening"
        ? "Listening…"
        : dictation.status === "pausing"
          ? "Pausing dictation…"
          : dictation.status === "paused"
            ? "Dictation paused"
            : dictation.status === "stopping"
              ? "Stopping dictation…"
              : dictation.status === "stopped"
                ? "Dictation stopped"
                : undefined;
  const callEligible=Boolean(voiceContext?.agents.some(agent=>agent.projectId===voiceContext.projectId && agent.conversationId===voiceContext.conversationId && (!voiceContext.selectedAgentId || agent.id===voiceContext.selectedAgentId)));
  const callDisabled=disabled || callOpen || recordingOpen || active || paused || !callEligible;
  const openCall=(invoker:HTMLButtonElement|null)=>{
    if(callDisabled || !invoker)return;
    callInvoker.current={node:invoker,owner:callOwner};
    setAnchor(null);setOpenedCallOwner(callOwner);
  };
  const closeCall=()=>{
    const focused=document.activeElement as HTMLElement|null;
    if(callInvoker.current?.owner===callOwner && (focused===document.body || focused?.closest?.('[data-ponderosa-call]')))
      restoreCallFocus.current=callInvoker.current;
    // Finish dismissing the focus trap before the next user interaction.
    flushSync(()=>setOpenedCallOwner(undefined));
  };
  const calledAgent=voiceContext?.agents.find(agent=>agent.id===voiceContext.selectedAgentId)?.title;
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  useEffect(() => {
    setNoticeDismissed(false);
    if (!statusLabel || active || paused || dictation.error) return;
    const timer = setTimeout(() => setNoticeDismissed(true), 3000);
    return () => clearTimeout(timer);
  }, [statusLabel, active, paused, dictation.error]);

  const openRecording = () => {
    if(disabled||callOpen||recordingOpen||active||paused||maxRecordingBytes<=0||!recordingContainer)return;
    onActiveChange?.(true);setAnchor(null);setOpenedRecordingOwner(callOwner);
  };
  return (
    <Box ref={rootRef} sx={[speechControlGroupSx, dictation.error ? { flexDirection: { xs: "column", sm: "row" }, alignItems: { xs: "flex-start", sm: "center" } } : {}]}>
      {callActionsHost&&createPortal(<Tooltip title={calledAgent?`Call ${calledAgent}`:"Call"}><span><IconButton aria-label="Call" disabled={callDisabled} onClick={event=>openCall(event.currentTarget)} sx={{width:44,height:44,borderRadius:"50%",color:"primary.main"}}><PhoneIcon/></IconButton></span></Tooltip>,callActionsHost)}
      {onVoiceAttachment&&!inlineVoiceOptions&&<Tooltip title="Record Voice Message"><span><IconButton
        ref={recordingButtonRef}
        aria-label="Record Voice Message"
        disabled={disabled||callOpen||recordingOpen||active||paused||maxRecordingBytes<=0||!recordingContainer}
        onClick={openRecording}
      ><MicNoneIcon/></IconButton></span></Tooltip>}
      <Tooltip title="Voice Options">
        <span>
          <IconButton
            ref={buttonRef}
            color={active || paused ? "primary" : "inherit"}
            aria-label="Voice Options"
            aria-haspopup="menu"
            aria-expanded={Boolean(anchor)}
            aria-controls={anchor ? menuId : undefined}
            disabled={disabled || callOpen || recordingOpen}
            onClick={event => setAnchor(event.currentTarget)}
          >
            <GraphicEqIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor) && !disabled}
        onClose={() => setAnchor(null)}
        // Keep the dictation surface accessible while its own menu is open.
        container={rootRef.current}
        MenuListProps={{"aria-label": "Voice Options"}}
        disableRestoreFocus={callOpen}
        disableScrollLock
      >
        {(!callActionsHost||inlineVoiceOptions)&&<MenuItem
          disabled={!anchor || callDisabled}
          onClick={() => { if (!anchor) return; openCall(buttonRef.current); }}
        >
          <ListItemIcon><PhoneIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={inlineVoiceOptions?"Voice Conversation":"Voice Call"} secondary={active || paused ? "Stop dictation first" : !voiceContext ? "Choose a source Chat and Agent" : undefined} />
        </MenuItem>}
        {inlineVoiceOptions&&onVoiceAttachment&&<MenuItem disabled={!anchor||disabled||callOpen||recordingOpen||active||paused||maxRecordingBytes<=0||!recordingContainer} onClick={openRecording}>
          <ListItemIcon><MicNoneIcon fontSize="small"/></ListItemIcon><ListItemText primary="Record Voice Message"/>
        </MenuItem>}
        <MenuItem
          disabled={!anchor || disabled || Boolean(unavailable) || busy}
          onClick={() => {
            if (!anchor) return;
            setAnchor(null);
            if (dictation.status === "listening" || dictation.status === "starting") dictation.pause();
            else if (paused) dictation.resume();
            else dictation.start();
          }}
        >
          <ListItemIcon><MicNoneIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Dictation" secondary={unavailable ?? (active || paused ? primaryLabel : undefined)} />
        </MenuItem>
      </Menu>
      {recordingOpen&&!disabled&&onVoiceAttachment&&recordingContainer&&createPortal(<VoiceMessageRecorder onAttach={(file,transcript)=>{const failure=onVoiceAttachment(file);if(!failure&&transcript)onFinalTranscript(transcript);return failure;}} maxBytes={maxRecordingBytes} onClose={()=>{restoreRecordingFocus.current=recordingContainer.contains(document.activeElement);setOpenedRecordingOwner(undefined);}}/>,recordingContainer)}
      {voiceContext && callOpen && !disabled && <VoiceConversation {...voiceContext} startOnOpen standalone={voiceContext.standalone??isOutputAppPath(window.location.pathname)} open onClose={closeCall} />}
      {active || paused ? (
        <Tooltip title="Stop Voice Dictation">
          <span>
            <IconButton
              aria-label="Stop Voice Dictation"
              disabled={busy}
              onClick={dictation.stop}
            >
              <StopIcon />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      {statusLabel && !noticeDismissed ? (
        <Typography
          aria-live="polite"
          color={dictation.error ? "error" : "text.secondary"}
          role={dictation.error ? "alert" : "status"}
          variant="caption"
          sx={[
            speechStatusSx,
            dictation.error ? { whiteSpace: "normal", overflowWrap: "anywhere" } : { "@media (max-width: 899.95px)": visuallyHiddenSpeechStatusSx },
          ]}
          title={statusLabel}
        >
          {statusLabel}
        </Typography>
      ) : null}
      {unavailable ? (
        <Box
          component="span"
          sx={visuallyHiddenSpeechStatusSx}
        >
          {unavailable}
        </Box>
      ) : null}
    </Box>
  );
}
