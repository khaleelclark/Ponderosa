import { Accordion, AccordionSummary, AccordionDetails, Alert, Box, Button, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from "@mui/material";
import type { ConversationDto, EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { createClientId } from "../clientId";
import { engineIsAvailable, resolveRuntimeSelection, soleAvailableEngineId } from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { Composer } from "./chat/Composer";
import { ProjectRuntimeFields } from "./ProjectRuntimeFields";
import { HostFolderPicker } from "./HostFolderPicker";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { runtimeControlState } from "../conversationEngine";

type CreationAttempt = { fingerprint: string; chatKey: string; agentKey: string; chat?: ConversationDto };
const attemptKey = "ponderosa.new-chat-attempt.v1";
function readAttempt(): CreationAttempt | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(attemptKey) ?? "null");
    if (value) {
      const input = JSON.parse(value.fingerprint);
      if (![input.text, input.engineId, input.model, input.effort].every(item => typeof item === "string")) return undefined;
    }
    return value && typeof value.fingerprint === "string" && typeof value.chatKey === "string"
      && typeof value.agentKey === "string" ? value : undefined;
  } catch { return undefined; }
}

/** Unsaved until Send. The same creation identities survive an ambiguous retry;
 * opening or leaving this surface never creates a persisted empty Chat. */
export function NewChatComposer({engines, preferences, onCreated}: {
  engines: EngineDto[]; preferences: WorkspacePreferencesDto;
  onCreated(projectId: string, conversationId: string): void;
}) {
  const queryClient = useQueryClient();
  const attempt = useRef<CreationAttempt | undefined>(readAttempt());
  const restored = attempt.current ? JSON.parse(attempt.current.fingerprint) : undefined;
  const [engineId, setEngineId] = useState<string>(restored?.engineId ?? "");
  const [model, setModel] = useState<string>(restored?.model ?? "");
  const [effort, setEffort] = useState<string>(restored?.effort ?? "");
  const [hostPath, setHostPath] = useState<string>(restored?.hostPath ?? "");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  useEffect(() => { setEngineId(current => current || soleAvailableEngineId(engines) || ""); }, [engines]);
  const engine = engines.find(item => item.id === engineId);
  const inherited = resolveRuntimeSelection(engine, preferences);
  const effective = runtimeControlState(engine, { model: model || inherited.model, effort: effort || inherited.effort });
  const modelLabel = effective.models.find(option => option.id === effective.model)?.label || effective.model || "Automatic model";
  const effortLabel = effective.efforts.find(option => option.id === effective.effort)?.label || effective.effort || "Automatic reasoning";
  const send = async (text: string) => {
    if (locked.current || !engine || !engineIsAvailable(engine)) throw new Error("Choose an available provider");
    const fingerprint = JSON.stringify({text, engineId, model, effort, hostPath});
    if (attempt.current && attempt.current.fingerprint !== fingerprint) {
      throw new Error("Retry the original message before changing its text or provider; its previous submission may have succeeded.");
    }
    const current = attempt.current ??= {fingerprint, chatKey:createClientId("chat-"),agentKey:createClientId("chat-agent-")};
    locked.current = true;setBusy(true);setError(undefined);
    try {
      sessionStorage.setItem(attemptKey, JSON.stringify(current));
      current.chat ??= await api.createChat({
        label:"New Chat", defaultEngine:engineId as ProjectDto["defaultEngine"],
        ...(hostPath ? {hostPath} : {}),
        ...(model ? {defaultModel:model} : {}), ...(effort ? {defaultEffort:effort} : {}),
      }, current.chatKey);
      sessionStorage.setItem(attemptKey, JSON.stringify(current));
      await api.createAgent(current.chat.projectId, current.chat.id, {
        title:"Assistant", engine:engineId, initialMessage:text,
        model:current.chat.defaultModel, effort:current.chat.defaultEffort,
        idempotencyKey:current.agentKey,
      });
      await Promise.all([
        queryClient.invalidateQueries({queryKey:queryKeys.projects.all}),
        queryClient.invalidateQueries({queryKey:queryKeys.workspaceDirectory.all}),
      ]);
      sessionStorage.removeItem(attemptKey);
      onCreated(current.chat.projectId,current.chat.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {locked.current=false;setBusy(false);}
  };
  return <Stack spacing={2} sx={{width:"100%",maxWidth:960,mx:"auto",my:"auto"}}>
    <Typography variant="h5">What would you like to work on?</Typography>
    <Composer disabled={busy || !engineIsAvailable(engine)} running={false} onSend={send}
      placeholder="Write a message…" destinationMode="project-chat" allowUnmentionedSend
      attachmentsEnabled={false} attachmentsUnavailableReason="Send the first message to create this chat, then attach files."
      enableVoiceDictation draftStorageKey="ponderosa.new-chat-draft.v1" />
    <Accordion disableGutters elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
    <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="new-chat-options" id="new-chat-options-header"><Typography variant="body2">Chat options · {engine?.displayName ?? "Choose provider"} · {modelLabel} · {effortLabel}</Typography></AccordionSummary>
    <AccordionDetails id="new-chat-options">
    <Box sx={{display:"flex",gap:1,flexWrap:"wrap"}}>
      <FormControl size="small" sx={{minWidth:160}} disabled={busy}>
        <InputLabel id="new-chat-provider-label">Provider</InputLabel>
        <Select labelId="new-chat-provider-label" label="Provider" value={engineId} onChange={event=>{setEngineId(event.target.value);setModel("");setEffort("");}}>
          {engines.map(item=><MenuItem key={item.id} value={item.id} disabled={!engineIsAvailable(item)}>{item.displayName}</MenuItem>)}
        </Select>
      </FormControl>
      <Box sx={{flex:"1 1 240px",minWidth:0}}><ProjectRuntimeFields engine={engine} inherited={inherited} model={model} effort={effort}
        onChange={selection=>{setModel(selection.model);setEffort(selection.effort);}}
        modelLabel="Model" effortLabel="Reasoning" modelLabelId="new-chat-model" effortLabelId="new-chat-effort"
        inheritedPrefix="Provider Default" inheritedFallback="Automatic" disabled={busy || !engineId} /></Box>
      <Button disabled={busy} onClick={()=>setFolderPickerOpen(true)}>
        {hostPath ? "Change working folder" : "Choose working folder (optional)"}
      </Button>
    </Box>
    {hostPath ? <Typography variant="caption" sx={{overflowWrap:"anywhere"}}>{hostPath}</Typography> : null}
    </AccordionDetails></Accordion>
    <HostFolderPicker open={folderPickerOpen} initialPath={hostPath || undefined}
      onClose={()=>setFolderPickerOpen(false)} onChoose={path=>{setHostPath(path);setFolderPickerOpen(false);}} />
    {error ? <Alert severity="error">{error}</Alert> : null}
  </Stack>;
}
