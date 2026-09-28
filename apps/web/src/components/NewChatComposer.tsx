import CloseIcon from "@mui/icons-material/Close";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import { Alert, Box, Button, IconButton, Paper, Typography } from "@mui/material";
import type { ConversationDto, EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { createClientId } from "../clientId";
import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from "../browserStorage";
import { engineIsAvailable, resolveRuntimeSelection, runtimeControlState, soleAvailableEngineId } from "../conversationEngine";
import { newChatSubmission } from "../conversationRouting";
import { pickAgentName } from "../parkNames";
import { queryKeys } from "../queryKeys";
import { Composer } from "./chat/Composer";
import { ChatComposerDock } from "./chat/ChatComposerDock";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { HostFolderPicker } from "./HostFolderPicker";

type CreationAttempt = { fingerprint: string; chatKey: string; agentKey: string; agentTitle?: string; chat?: ConversationDto };
const attemptKey = "ponderosa.new-chat-attempt.v1";
function readAttempt(): CreationAttempt | undefined {
  try {
    const value = JSON.parse(readBrowserStorage("sessionStorage", attemptKey) ?? "null");
    if (value) {
      const input = JSON.parse(value.fingerprint);
      if (![input.text, input.engineId, input.model, input.effort, input.speed ?? ""].every(item => typeof item === "string")) return undefined;
    }
    return value && typeof value.fingerprint === "string" && typeof value.chatKey === "string"
      && typeof value.agentKey === "string" ? value : undefined;
  } catch { return undefined; }
}

/** Unsaved until Send. The same creation identities survive an ambiguous retry;
 * opening or leaving this surface never creates a persisted empty Chat. */
export function NewChatComposer({engines, enginesLoaded = true, preferences, onCreated}: {
  engines: EngineDto[]; enginesLoaded?: boolean; preferences: WorkspacePreferencesDto;
  onCreated(projectId: string, conversationId: string): void;
}) {
  const queryClient = useQueryClient();
  const attempt = useRef<CreationAttempt | undefined>(readAttempt());
  const restored = attempt.current ? JSON.parse(attempt.current.fingerprint) : undefined;
  const [engineId, setEngineId] = useState<string>(restored?.engineId ?? "");
  const [model, setModel] = useState<string>(restored?.model ?? "");
  const [effort, setEffort] = useState<string>(restored?.effort ?? "");
  const [speed, setSpeed] = useState<string>(restored?.speed ?? "");
  const [hostPath, setHostPath] = useState<string>(typeof restored?.hostPath === "string" ? restored.hostPath : "");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  const capabilityButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setEngineId(current => current || soleAvailableEngineId(engines) || ""); }, [engines]);
  const engine = engines.find(item => item.id === engineId);
  const inherited = resolveRuntimeSelection(engine, preferences);
  const effective = runtimeControlState(engine, {
    model: model || inherited.model,
    effort: effort || inherited.effort,
    speed: speed || inherited.speed,
  });
  const send = async (text: string) => {
    if (locked.current || !engine || !engineIsAvailable(engine)) throw new Error("Choose an available provider");
    const submission = newChatSubmission(text);
    if (submission.kind === "broadcast" && !submission.text) {
      throw new Error("Add informational context after #broadcast.");
    }
    const fingerprint = JSON.stringify({text, engineId, model, effort, speed, hostPath});
    if (attempt.current && attempt.current.fingerprint !== fingerprint) {
      throw new Error("Retry the original message before changing its text or provider; its previous submission may have succeeded.");
    }
    const current = attempt.current ??= {
      fingerprint, chatKey:createClientId("chat-"),agentKey:createClientId("chat-agent-"),
      ...(submission.kind === "agent" ? { agentTitle: pickAgentName([]) } : {}),
    };
    if (submission.kind === "agent") current.agentTitle ??= pickAgentName([]);
    locked.current = true;setBusy(true);setError(undefined);
    try {
      writeBrowserStorage("sessionStorage", attemptKey, JSON.stringify(current));
      current.chat ??= await api.createChat({
        label:"New Chat", defaultEngine:engineId as ProjectDto["defaultEngine"],
        ...(hostPath ? {hostPath} : {}),
        ...(model ? {defaultModel:model} : {}), ...(effort ? {defaultEffort:effort} : {}),
        ...(speed ? {defaultSpeed:speed} : {}),
      }, current.chatKey);
      writeBrowserStorage("sessionStorage", attemptKey, JSON.stringify(current));
      if (submission.kind === "broadcast") {
        await api.sendConversationMessage(current.chat.id, {
          text: submission.text,
          engine: engineId,
          model: current.chat.defaultModel,
          effort: current.chat.defaultEffort,
          speed: current.chat.defaultSpeed,
          activeRunDelivery: "steer",
          idempotencyKey: current.agentKey,
        });
      } else {
        await api.createAgent(current.chat.projectId, current.chat.id, {
          title:current.agentTitle!, engine:engineId, initialMessage:submission.text,
          model:current.chat.defaultModel, effort:current.chat.defaultEffort,
          speed:current.chat.defaultSpeed,
          idempotencyKey:current.agentKey,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({queryKey:queryKeys.projects.all}),
        queryClient.invalidateQueries({queryKey:queryKeys.workspaceDirectory.all}),
      ]);
      removeBrowserStorage("sessionStorage", attemptKey);
      onCreated(current.chat.projectId,current.chat.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {locked.current=false;setBusy(false);}
  };
  const runtimeControls = <ComposerRuntimeSelector
    loading={!enginesLoaded}
    engine={engineId}
    engines={engines.map(option => ({
      id: option.id,
      label: option.displayName,
      disabled: !engineIsAvailable(option),
      detail: engineIsAvailable(option) ? undefined : option.authentication === "authenticated" ? "Access unavailable" : "Signed out",
    }))}
    model={effective.model}
    models={effective.models}
    effort={effective.effort}
    efforts={effective.efforts}
    speed={effective.speed}
    speeds={effective.speeds}
    disabled={busy}
    onEngineChange={next => { setEngineId(next); setModel(""); setEffort(""); setSpeed(""); }}
    onModelChange={setModel}
    onEffortChange={setEffort}
    onSpeedChange={setSpeed}
  />;
  return <Box sx={{height:"100%",minHeight:0,minWidth:0,display:"grid",gridTemplateRows:"minmax(0, 1fr) auto"}}>
    <Box role="region" aria-label="Chat messages" sx={{minHeight:0}} />
    <ChatComposerDock>
      {error ? <Alert severity="error" sx={{mb:1}}>{error}</Alert> : null}
      {hostPath ? <Paper
        variant="outlined"
        sx={{
          mb: 0.75,
          minHeight: { xs: 44, md: 36 },
          px: 0.75,
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        <FolderOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "text.secondary" }} />
        <Typography variant="caption" noWrap title={hostPath} sx={{ minWidth: 0 }}>
          <Box component="span" sx={{ fontWeight: 700 }}>Working folder:</Box> {hostPath}
        </Typography>
        <Button size="small" onClick={() => setFolderPickerOpen(true)} sx={{ minHeight: { xs: 44, md: 32 } }}>Change</Button>
        <IconButton size="small" aria-label="Clear working folder" onClick={() => {
          setHostPath("");
          window.requestAnimationFrame(() => capabilityButtonRef.current?.focus({ preventScroll: true }));
        }} sx={{ width: { xs: 44, md: 32 }, height: { xs: 44, md: 32 } }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper> : null}
      <Composer disabled={busy} running={false} onSend={send}
        placeholder="Write a message…" destinationMode="project-chat" allowUnmentionedSend={engineIsAvailable(engine)}
        sendUnavailableReason="Choose an available provider"
        controls={runtimeControls}
        capabilityButtonRef={capabilityButtonRef}
        menuActions={[{
          id: "working-folder",
          label: hostPath ? "Change working folder" : "Working folder",
          description: hostPath || "Choose an optional folder on the Ponderosa host.",
          icon: <FolderOutlinedIcon fontSize="small" />,
          onSelect: () => setFolderPickerOpen(true),
        }]}
        attachmentsEnabled={false} attachmentsUnavailableReason="Send the first message to create this chat, then attach files."
        enableVoiceDictation draftStorageKey="ponderosa.new-chat-draft.v1" />
    </ChatComposerDock>
    <HostFolderPicker
      open={folderPickerOpen}
      initialPath={hostPath || undefined}
      onClose={() => setFolderPickerOpen(false)}
      onChoose={path => { setHostPath(path); setFolderPickerOpen(false); }}
    />
  </Box>;
}
