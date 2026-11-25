import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import { Alert, Box, Button, CircularProgress, Popover, Stack, Typography } from "@mui/material";
import type { ConversationDto, CreateProjectRequest, EngineDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { pickAgentName } from "../parkNames";
import { Composer, ComposerSubmissionReported } from "./chat/Composer";
import { ChatComposerDock } from "./chat/ChatComposerDock";
import { ChatSurface } from "./chat/ChatSurface";
import { composerSurfaceWidth } from "./chat/Composer.styles";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { ConversationHeader, EmptyChatMessage } from "./ConversationView.parts";
import type { ComposerDraftSnapshot } from "./chat/Composer.types";
import { NEW_AGENT_DESTINATION_HANDLE, removeComposerDestinations } from "./chat/composerDestination";
import { buildMarkdownTranscript } from "../chatTranscript";
import { createClientId } from "../clientId";
import { useRuntimeControls } from "../hooks/useRuntimeControls";
import { chatCreationFiles } from "./chatCreationFiles";
import { ApiRequestError } from "../api/types";
import { definitiveSubmissionStatus } from "./idempotentAttempt";
import { engineIsAvailable, engineUnavailableReason, resolveConversationEngine, resolveRuntimeSelection, type RuntimeSelection } from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { ensureCreationAttemptPersisted, mayRecordCreationReceipt, mayRetryCreationAttempt, readDurableChatAttempts, saveCreationAttempts, sameCreationOwner, sameCreationAttempt, moveCreationDraft, settleCreationContinuation, settleCreationDraft, submitChatOpening, submitCreationAttempt, withChatCreationReceipt, type ChatCreationAttempt, type ChatCreationContinuation, type ChatCreationOwner } from "./chatCreationAttempts";

/** Ordinary Chats choose their working folder before the first saved action. */
export function NewChatComposer({ creationKey, engines, enginesLoaded = true, onCreated, onCancel, onConfigureProvider, onPendingChange, owner, preferences, inline = false }: {
  creationKey?: string;
  owner?: ChatCreationOwner; inline?: boolean;
  engines: EngineDto[]; enginesLoaded?: boolean; preferences?: WorkspacePreferencesDto;
  onCreated(projectId: string, conversationId: string, continuation?: ChatCreationContinuation): boolean | void;
  onCancel?(): void;
  onConfigureProvider?(): void;
  onPendingChange?(pending: boolean): void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [retryNeeded, setRetryNeeded] = useState(false);
  const [rejectedOpening, setRejectedOpening] = useState<ChatCreationAttempt>();
  const snapshotRef = useRef<() => ComposerDraftSnapshot>(null);
  const [runtimeChoice, setRuntimeChoice] = useState<{ engineId: string; selection: RuntimeSelection }>();
  const selectedEngineId = runtimeChoice?.engineId ?? resolveConversationEngine(undefined, engines);
  const selectedEngine = engines.find(engine => engine.id === selectedEngineId);
  const runtime = useRuntimeControls({
    engine: selectedEngine,
    preferences,
    selection: runtimeChoice?.selection ?? resolveRuntimeSelection(selectedEngine, preferences),
    onChange: selection => {
      if (selectedEngineId) setRuntimeChoice({ engineId: selectedEngineId, selection });
    },
  });
  const chooseEngine = (engineId: string) => setRuntimeChoice({
    engineId,
    selection: resolveRuntimeSelection(engines.find(engine => engine.id === engineId), preferences),
  });
  const draftKey = creationKey ? chatStateKey("draft", `new-chat.${creationKey}`) : undefined;
  const [folderAnchor, setFolderAnchor] = useState<HTMLElement | null>(null);
  const [browsePath, setBrowsePath] = useState<string>();
  const [folder, setFolder] = useState<string>();
  const folders = useQuery({
    queryKey: ["new-chat-working-folders", browsePath],
    queryFn: () => api.browseProjectFolders(browsePath),
    enabled: Boolean(folderAnchor),
    retry: false,
  });
  const locked = useRef(false);
  const autoStarted = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { onPendingChange?.(busy); }, [busy, onPendingChange]);
  const retire = (attempt:ChatCreationAttempt):boolean => {
    try {
      const journal=readDurableChatAttempts();
      if(!mayRetryCreationAttempt(journal,attempt))return false;
      return saveCreationAttempts(journal.filter(item=>!sameCreationAttempt(item,attempt)));
    }catch{return false;}
  };
  const open = (chat: Pick<ConversationDto, "id" | "projectId">, attempt?: ChatCreationAttempt) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all }).catch(() => {});
    if (!mounted.current) return;
    if (onCreated(chat.projectId, chat.id, attempt?.continuation) === false) {
      setError("Chat was saved. Retry to open the same Chat when navigation is available.");
    } else if (attempt?.continuation) {
      settleCreationContinuation(attempt, chat);
    }
  };
  const moveLocalDraft = (chat: Pick<ConversationDto, "id">, text: string | undefined) => {
    if (!text) return;
    const key = chatStateKey("draft", `conversation.${chat.id}.main`);
    const existing = readChatState(key);
    if ((existing && existing !== text) || !writeChatState(key, text))
      throw new Error("The draft could not be moved. Copy it before opening the Chat.");
  };
  const create = async (retry?: ChatCreationAttempt, request?: { text: string } | ChatCreationContinuation) => {
    if (locked.current || !creationKey) return;
    let journal: ChatCreationAttempt[];
    try { journal = readDurableChatAttempts(); }
    catch { setError("Chat creation storage is unavailable or unreadable. Preserve browser data and recover the earlier request."); return; }
    const saved = retry ?? journal.find(item => item.key === creationKey && sameCreationOwner(item.owner, owner));
    const engineId = owner ? resolveConversationEngine(undefined, engines) : selectedEngineId;
    if (!saved && !engineId) {
      setError("No provider is configured. Configure a provider, then open a new Chat.");
      return;
    }
    if (saved?.origin === "import_destination") {
      setError("Use Recover import destination to review this saved request.");
      return;
    }
    const snapshot = !saved && request ? snapshotRef.current?.() : undefined;
    const fileCapture = snapshot?.files.length
      ? { key: createClientId(), count: snapshot.files.length }
      : undefined;
    const openingText = request && "text" in request ? request.text : undefined;
    const current: ChatCreationAttempt = saved ?? {
      key: creationKey, ...(owner ? {owner} : {}),
      input: {
        label: "New Chat",
        defaultEngine: engineId as CreateProjectRequest["defaultEngine"],
        ...(!owner && runtime.model ? { defaultModel: runtime.model } : {}),
        ...(!owner && runtime.effort ? { defaultEffort: runtime.effort } : {}),
        ...(!owner && runtime.speed ? { defaultSpeed: runtime.speed } : {}),
        ...(folder ? { hostPath: folder } : {}),
      },
      ...(snapshot ? { draft: {
        ...(snapshot.text === openingText ? {} : { text: snapshot.text }),
        ...(snapshot.rawText.trim() === snapshot.text ? {} : { rawText: snapshot.rawText }),
        ownerId: snapshot.ownerId,
        ...(fileCapture ? { files: fileCapture } : {}),
      } } : {}),
      ...(request && ("text" in request
        ? { opening: { text: request.text, title: pickAgentName([]) } }
        : { continuation: request })),
    };
    locked.current = true;
    setBusy(true);
    setError(undefined);
    setRejectedOpening(undefined);
    setRetryNeeded(true);
    let completed: ChatCreationAttempt | undefined;
    let persisted = Boolean(saved);
    try {
      if (fileCapture && snapshot) await chatCreationFiles("write", fileCapture.key, snapshot.files);
      if (!ensureCreationAttemptPersisted(current)) {
        if (fileCapture) void chatCreationFiles("remove", fileCapture.key).catch(() => {});
        setRetryNeeded(Boolean(saved));
        setError("Browser storage is unavailable. Enable it so an unconfirmed Chat creation can be retried safely.");
        return;
      }
      persisted = true;
      const chat = await submitCreationAttempt(current);
      // Refresh the original owner even if navigation or the receipt write fails.
      if (owner) void queryClient.invalidateQueries({ queryKey: ["branch-chats", owner.branchId] }).catch(() => {});
      // History/settings can revisit a committed key even after navigation.
      // Keep its exact original input and a completion receipt, not a new tuple.
      let journal:ChatCreationAttempt[];
      try { journal=readDurableChatAttempts(); }
      catch { if (mounted.current) setError("Chat was saved, but its local receipt could not be saved. The original request is retained."); return; }
      if (!mayRecordCreationReceipt(journal, current, chat)) {
        throw new Error("Destination receipt conflicts with saved information. The original evidence is retained.");
      }
      const receipt = withChatCreationReceipt(current, chat);
      if (!saveCreationAttempts([...journal.filter(item => !sameCreationAttempt(item, current)), receipt])) {
        // The already-persisted original attempt remains safe for exact replay.
        if (mounted.current) setError("Chat was saved, but its local receipt could not be saved. Retry to open the same Chat.");
        return;
      }
      completed = receipt;
      if (completed.opening) await submitChatOpening(completed, chat);
      else if (completed.draft) completed = await moveCreationDraft(completed, chat);
      else if (mounted.current && draftKey && !completed.continuation) {
        // An earlier text-only attempt may predate captured handoff drafts.
        const text = readChatState(draftKey);
        moveLocalDraft(chat, text);
        if (text) writeChatState(draftKey, "");
      }
      open(chat, completed);
      return true;
    } catch (failure) {
      const definite = current.origin !== "import_destination" && failure instanceof ApiRequestError && definitiveSubmissionStatus(failure.status, failure.message) &&
        !(failure.status === 409 && /reused|replay conflict|memory setup/iu.test(failure.message));
      const retired = definite && !completed && !current.chat &&
        // On reload the captured copy may be the only copy of the files.
        (!current.draft?.files || Boolean(snapshot)) && retire(current);
      if (retired && fileCapture) void chatCreationFiles("remove", fileCapture.key).catch(() => {});
      if (mounted.current) {
        setRetryNeeded(!retired && persisted);
        if (definite && completed?.opening && failure.status !== 409) {
          try {
            setRejectedOpening(readDurableChatAttempts().find(item => sameCreationAttempt(item, current)));
          } catch { /* Keep exact retry available if the receipt cannot be read. */ }
        }
        const next = !persisted ? "" : retired ? " Correct the settings and try again."
          : completed?.opening ? " Retry the same opening message."
          : completed ? " The Chat is saved. Retry to continue the same action."
          : " Creation is unconfirmed. Retry to open the same Chat if it was created.";
        setError(`${failure instanceof Error ? failure.message : String(failure)}${next}`);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!creationKey || !enginesLoaded || autoStarted.current) return;
    autoStarted.current = true;
    if (owner) { void create(); return; }
    try {
      const saved = readDurableChatAttempts().find(item => item.key === creationKey && sameCreationOwner(item.owner, owner));
      if (saved) {
        const input = saved.input;
        setFolder(input.hostPath);
        setRuntimeChoice({
          engineId: input.defaultEngine,
          selection: resolveRuntimeSelection(engines.find(engine => engine.id === input.defaultEngine), preferences, undefined, {
            model: input.defaultModel,
            effort: input.defaultEffort,
            speed: input.defaultSpeed,
          }),
        });
        void create(saved);
      }
    } catch { setError("Chat creation storage is unavailable or unreadable. Preserve browser data and recover the earlier request."); }
  }, [creationKey, enginesLoaded, engines, owner]);
  if (owner) return <Stack spacing={2} alignItems="center" sx={{ p: inline ? 1 : 2 }}>
    {error ? <>
      <Alert severity="error">{error}</Alert>
      <Stack direction="row" spacing={1}>
        <Button disabled={busy || !enginesLoaded} onClick={() => void create()}>Retry</Button>
        {onConfigureProvider && <Button disabled={busy} onClick={onConfigureProvider}>Provider Settings</Button>}
      </Stack>
    </> : <CircularProgress size={24} aria-label="Opening New Chat" />}
    {onCancel && <Button disabled={busy} onClick={onCancel}>Back</Button>}
  </Stack>;

  const canCreate = Boolean(creationKey && enginesLoaded && engineIsAvailable(selectedEngine));
  const actionsDisabled = busy || retryNeeded || !canCreate;
  const closeFolder = () => setFolderAnchor(null);
  const recoverDraft = async (attempt: ChatCreationAttempt) => {
    if (!attempt.chat || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      if (attempt.draft) await moveCreationDraft(attempt, attempt.chat);
      else {
        moveLocalDraft(attempt.chat, attempt.opening?.text);
        settleCreationDraft(attempt, attempt.chat);
      }
      open(attempt.chat);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <Box sx={{
    height: "100%", minHeight: 0, minWidth: 0, display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    "& > [data-workspace-header] h1.MuiTypography-h6": { fontSize: "1.25rem" },
    "& > [data-workspace-header] h1.MuiTypography-body2": { fontSize: "0.8125rem" },
  }}>
    <ConversationHeader activeView="main" actionsDisabled={actionsDisabled}
      transcriptMarkdown={() => buildMarkdownTranscript("New Chat", [])}
      onAction={initialAction => void create(undefined, { initialAction })}
      setActiveView={view => {
        if (view !== "main" && !actionsDisabled) void create(undefined, { view });
      }} />
    <Box id="chat-workspace-main-panel" role="tabpanel" aria-labelledby="chat-workspace-main-tab" sx={{ minHeight: 0 }}>
      <ChatSurface layoutKey="new-chat" layout="project" label="Chat Messages">
        <Box sx={{ mb: 2 }}><EmptyChatMessage /></Box>
      </ChatSurface>
    </Box>
    <ChatComposerDock>
      <Stack spacing={0.5} alignItems="center" sx={{ mx: "auto", width: composerSurfaceWidth, mb: 0.5 }}>
        {error && <Alert severity="error" sx={{ alignSelf: "stretch" }}>{error}</Alert>}
        {enginesLoaded && !canCreate && onConfigureProvider &&
          <Button size="small" onClick={onConfigureProvider}>Provider Settings</Button>}
        {retryNeeded && <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Button size="small" disabled={busy || !enginesLoaded} onClick={() => void create()}>Retry</Button>
          {rejectedOpening?.chat && <Button size="small" disabled={busy} onClick={() => void recoverDraft(rejectedOpening)}>
            Open Chat With Draft
          </Button>}
        </Stack>}
        <Button size="small" color="inherit" startIcon={<FolderOutlinedIcon />}
          aria-label={`Choose working folder: ${folder ?? "Automatic working folder"}`}
          aria-haspopup="dialog" aria-expanded={Boolean(folderAnchor)}
          title={folder ?? "Automatic working folder"} disabled={busy || retryNeeded}
          sx={{ minWidth: 0, maxWidth: "100%", textTransform: "none" }}
          onClick={event => setFolderAnchor(event.currentTarget)}>
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {folder ?? "Automatic working folder"}
          </Box>
        </Button>
      </Stack>
      <Composer
        disabled={false}
        running={busy || retryNeeded}
        submissionDisabled={actionsDisabled}
        destinationMode="project-chat"
        enableVoiceDictation
        placeholder="Write a message…"
        draftStorageKey={draftKey}
        draftSnapshotRef={snapshotRef}
        controls={<ComposerRuntimeSelector
          engine={selectedEngineId ?? ""}
          engines={engines.map(engine => ({
            id: engine.id, label: engine.displayName,
            disabled: !engineIsAvailable(engine), detail: engineUnavailableReason(engine),
          }))}
          model={runtime.model} models={runtime.models}
          effort={runtime.effort} efforts={runtime.efforts}
          speed={runtime.speed} speeds={runtime.speeds}
          selectionKey={creationKey ?? "new-chat"}
          loading={!enginesLoaded} disabled={busy || retryNeeded}
          onEngineChange={chooseEngine}
          onReset={() => { if (selectedEngineId) chooseEngine(selectedEngineId); }}
          onModelChange={runtime.selectModel}
          onEffortChange={runtime.selectEffort}
          onSpeedChange={runtime.selectSpeed}
        />}
        onSend={async (text, _files, _ids, _owner, context) => {
          const opening = context?.newAgentRequested
            ? removeComposerDestinations(text, [NEW_AGENT_DESTINATION_HANDLE]).trim()
            : text;
          if (!await create(undefined, { text: opening })) throw new ComposerSubmissionReported("Your message is still here.");
        }}
      />
    </ChatComposerDock>
    <Popover open={Boolean(folderAnchor)} anchorEl={folderAnchor} onClose={closeFolder}
      anchorOrigin={{ vertical: "top", horizontal: "center" }} transformOrigin={{ vertical: "bottom", horizontal: "center" }}
      slotProps={{ paper: { role: "dialog", "aria-label": "Choose working folder", sx: { p: 1.5, width: 360, maxWidth: "calc(100vw - 32px)" } } }}>
      <Stack spacing={1} alignItems="flex-start">
        <Button size="small" onClick={() => { setFolder(undefined); closeFolder(); }}>Use automatic folder</Button>
        {folders.isPending && <CircularProgress size={20} aria-label="Loading host folders" />}
        {folders.error && <Alert severity="error" action={<Button onClick={() => void folders.refetch()}>Retry</Button>}>{folders.error.message}</Alert>}
        {folders.data && <>
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{folders.data.path}</Typography>
          <Stack direction="row" useFlexGap flexWrap="wrap">
            <Button onClick={() => { setFolder(folders.data.path); closeFolder(); }}>Use this folder</Button>
            {folders.data.parentPath && <Button onClick={() => setBrowsePath(folders.data.parentPath)}>Parent folder</Button>}
          </Stack>
          <Stack sx={{ maxHeight: "min(240px, 34dvh)", overflow: "auto", width: "100%" }} alignItems="flex-start">
            {folders.data.folders.map(entry => <Button key={entry.hostPath} sx={{ overflowWrap: "anywhere" }} onClick={() => setBrowsePath(entry.hostPath)}>{entry.name}</Button>)}
          </Stack>
        </>}
      </Stack>
    </Popover>
  </Box>;
}
