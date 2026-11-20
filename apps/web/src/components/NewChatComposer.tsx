import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import { Alert, Box, Button, CircularProgress, Popover, Stack, Typography } from "@mui/material";
import type { ConversationDto, CreateProjectRequest, EngineDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { pickAgentName } from "../parkNames";
import { Composer } from "./chat/Composer";
import { ChatComposerDock } from "./chat/ChatComposerDock";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { ApiRequestError } from "../api/types";
import { definitiveSubmissionStatus } from "./idempotentAttempt";
import { resolveConversationEngine } from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { ensureCreationAttemptPersisted, mayRecordCreationReceipt, mayRetryCreationAttempt, readDurableChatAttempts, saveCreationAttempts, sameCreationOwner, sameCreationAttempt, settleChatOpening, submitChatOpening, submitCreationAttempt, withChatCreationReceipt, type ChatCreationAttempt, type ChatCreationOwner } from "./chatCreationAttempts";

/** Ordinary Chats are saved on first send or an explicit empty Chat action.
 * Workflow setup keeps its existing automatic entry. */
export function NewChatComposer({ creationKey, engines, enginesLoaded = true, onCreated, onCancel, onConfigureProvider, onPendingChange, owner, inline = false }: {
  creationKey?: string;
  owner?: ChatCreationOwner; inline?: boolean;
  engines: EngineDto[]; enginesLoaded?: boolean; preferences?: WorkspacePreferencesDto;
  onCreated(projectId: string, conversationId: string): boolean | void;
  onCancel?(): void;
  onConfigureProvider?(): void;
  onPendingChange?(pending: boolean): void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [retryNeeded, setRetryNeeded] = useState(false);
  const [rejectedOpening, setRejectedOpening] = useState<ChatCreationAttempt>();
  const [importChat, setImportChat] = useState<ConversationDto>();
  const importOnCreate = useRef(false);
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
  const open = (chat: Pick<ConversationDto, "id" | "projectId">) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all }).catch(() => {});
    if (mounted.current && onCreated(chat.projectId, chat.id) === false) setError("Chat was saved. Retry to open the same Chat when navigation is available.");
  };
  const openWithDraft = (chat: Pick<ConversationDto, "id" | "projectId">, text?: string, attempt?: ChatCreationAttempt) => {
    const key = chatStateKey("draft", `conversation.${chat.id}.main`);
    const existing = readChatState(key);
    if (text && ((existing && existing !== text) || !writeChatState(key, text))) {
      setError("The draft could not be moved. Copy it before opening the Chat.");
      return;
    }
    try {
      if (attempt) settleChatOpening(attempt, chat);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    if (text && draftKey) writeChatState(draftKey, "");
    setImportChat(undefined);
    open(chat);
  };
  const create = async (retry?: ChatCreationAttempt, text?: string) => {
    if (locked.current || !creationKey) return;
    let journal:ChatCreationAttempt[];
    try { journal=readDurableChatAttempts(); }
    catch { setError("Chat creation storage is unavailable or unreadable. Preserve browser data and recover the earlier request."); return; }
    const saved = retry ?? journal.find(item => item.key === creationKey && sameCreationOwner(item.owner, owner));
    const engineId = resolveConversationEngine(undefined, engines);
    if (!saved && !engineId) {
      setError("No provider is configured. Configure a provider, then open a new Chat.");
      return;
    }
    // The server resolves advertised defaults into the saved Chat. Its normal
    // composer shows/edits that exact tuple; old form values are never reused.
    const current: ChatCreationAttempt = saved ?? {
      key: creationKey, ...(owner ? {owner} : {}),
      input: { label: "New Chat", defaultEngine: engineId as CreateProjectRequest["defaultEngine"], ...(folder ? { hostPath: folder } : {}) },
      ...(text ? { opening: { text, title: pickAgentName([]) } } : {}),
    };
    if (current.origin === "import_destination") {
      setError("Use Recover import destination to review this saved request.");
      return;
    }
    if (!ensureCreationAttemptPersisted(current)) {
      setError("Browser storage is unavailable. Enable it so an unconfirmed Chat creation can be retried safely.");
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(undefined);
    setRejectedOpening(undefined);
    setRetryNeeded(true);
    let completed: ChatCreationAttempt | undefined;
    try {
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
      if (mounted.current && !completed.opening && importOnCreate.current) setImportChat(chat);
      else if (mounted.current && draftKey) openWithDraft(chat, readChatState(draftKey));
      else open(chat);
      return true;
    } catch (failure) {
      const definite = current.origin !== "import_destination" && failure instanceof ApiRequestError && definitiveSubmissionStatus(failure.status, failure.message) &&
        !(failure.status === 409 && /reused|replay conflict/iu.test(failure.message));
      const retired = definite && !completed && !current.chat && retire(current);
      if (mounted.current) {
        setRetryNeeded(!retired);
        if (definite && completed?.opening && failure.status !== 409) setRejectedOpening(completed);
        const next = retired ? " Correct the settings and try again."
          : completed?.opening ? " Retry the same opening message."
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
      if (saved) void create(saved);
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

  const canCreate = Boolean(creationKey && enginesLoaded && resolveConversationEngine(undefined, engines));
  const actionsDisabled = busy || retryNeeded || !canCreate;
  const closeFolder = () => setFolderAnchor(null);
  return <Box sx={{
    height: "100%", minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end",
    px: { xs: 1.5, sm: 3 }, pb: "max(12px, env(safe-area-inset-bottom))",
  }}>
    <Box sx={{ width: "100%", maxWidth: 820, mx: "auto", minHeight: 0, overflowY: "auto" }}>
      <ChatComposerDock>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        {enginesLoaded && !canCreate && onConfigureProvider &&
          <Button size="small" onClick={onConfigureProvider}>Provider Settings</Button>}
        {retryNeeded && <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Button size="small" disabled={busy || !enginesLoaded} onClick={() => void create()}>Retry</Button>
          {rejectedOpening?.chat && <Button size="small" disabled={busy} onClick={() => openWithDraft(
            rejectedOpening.chat!, rejectedOpening.opening?.text, rejectedOpening,
          )}>Open Chat With Draft</Button>}
        </Stack>}
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5 }}>
          <Button size="small" color="inherit" startIcon={<FolderOutlinedIcon />}
            aria-label="Choose working folder" aria-haspopup="dialog" aria-expanded={Boolean(folderAnchor)}
            title={folder} disabled={busy || retryNeeded} sx={{ minWidth: 0, justifyContent: "flex-start" }}
            onClick={event => setFolderAnchor(event.currentTarget)}>
            <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {folder ?? "Automatic working folder"}
            </Box>
          </Button>
          <Button size="small" color="inherit" startIcon={<UploadFileOutlinedIcon />}
            aria-label="Import Agent or organization" disabled={actionsDisabled} sx={{ flexShrink: 0 }}
            onClick={() => { importOnCreate.current = true; void create(); }}>
            Import
          </Button>
          {onCancel && <Button size="small" color="inherit" disabled={busy} sx={{ flexShrink: 0, ml: "auto" }} onClick={onCancel}>Back</Button>}
        </Stack>
        <Composer
          disabled={false}
          running={busy}
          submissionDisabled={actionsDisabled}
          placeholder="Write a message…"
          draftStorageKey={draftKey}
          attachmentsEnabled={false}
          attachmentsUnavailableReason="Open a Chat to attach files."
          menuActions={[{ id: "empty-chat", label: "Open empty Chat", disabled: actionsDisabled, onSelect: () => { importOnCreate.current = false; void create(); } }]}
          onSend={async text => {
            importOnCreate.current = false;
            if (!await create(undefined, text)) throw new Error("Your message is still here.");
          }}
        />
      </ChatComposerDock>
    </Box>
    <Popover open={Boolean(folderAnchor)} anchorEl={folderAnchor} onClose={closeFolder}
      anchorOrigin={{ vertical: "top", horizontal: "left" }} transformOrigin={{ vertical: "bottom", horizontal: "left" }}
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
    {importChat && <ImportAgentDialog open projectId={importChat.projectId} conversations={[importChat]}
      initialConversationId={importChat.id} fixedConversationId={importChat.id} engines={engines}
      onClose={() => {
        setImportChat(undefined);
        importOnCreate.current = false;
        openWithDraft(importChat, draftKey ? readChatState(draftKey) : undefined);
      }} />}
  </Box>;
}
