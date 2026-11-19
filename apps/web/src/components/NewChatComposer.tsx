import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import type { ConversationDto, CreateProjectRequest, EngineDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { definitiveSubmissionStatus } from "./idempotentAttempt";
import { resolveConversationEngine } from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { ensureCreationAttemptPersisted, mayRecordCreationReceipt, mayRetryCreationAttempt, readDurableChatAttempts, saveCreationAttempts, sameCreationOwner, sameCreationAttempt, submitCreationAttempt, type ChatCreationAttempt, type ChatCreationOwner } from "./chatCreationAttempts";

/** A transient entry, not a setup screen: persist an empty Chat, then open its
 * normal workspace. The route identity survives refresh and exact retries. */
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
  const [canChangeFolder, setCanChangeFolder] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState<string>();
  const [folder, setFolder] = useState<string>();
  const folders = useQuery({
    queryKey: ["new-chat-working-folders", browsePath],
    queryFn: () => api.browseProjectFolders(browsePath),
    enabled: browsing && !owner,
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
  const create = async (retry?: ChatCreationAttempt) => {
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
    };
    if (current.origin === "import_destination") {
      setError("Use Recover import destination to review this saved request.");
      return;
    }
    if (!ensureCreationAttemptPersisted(current)) {
      setError("Browser storage is unavailable. Enable it so an unconfirmed Chat creation can be retried safely.");
      return;
    }
    locked.current = true; setBusy(true); setError(undefined); setCanChangeFolder(false);
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
      const completed = { ...current, chat: { id: chat.id, projectId: chat.projectId } };
      if (!saveCreationAttempts([...journal.filter(item => !sameCreationAttempt(item, current)), completed])) {
        // The already-persisted original attempt remains safe for exact replay.
        if (mounted.current) setError("Chat was saved, but its local receipt could not be saved. Retry to open the same Chat.");
        return;
      }
      open(chat);
    } catch (failure) {
      const definite = current.origin !== "import_destination" && failure instanceof ApiRequestError && definitiveSubmissionStatus(failure.status, failure.message) &&
        !(failure.status === 409 && /reused|replay conflict/iu.test(failure.message));
      const retired=definite && !current.chat && retire(current);
      if (mounted.current) {
        setCanChangeFolder(Boolean(retired && !owner));
        setError(`${failure instanceof Error ? failure.message : String(failure)}${retired
          ? " Correct the settings and retry."
          : " Creation is unconfirmed. Retry to open the same Chat if it was created."}`);
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
  return <Box sx={{ height: inline ? "auto" : "100%", display: "flex", alignItems: "center", justifyContent: "center", p: inline ? 1 : 2 }}>
    <Stack spacing={2} alignItems="center">
    {!error ? busy || owner || !enginesLoaded ? <CircularProgress size={24} aria-label="Opening New Chat" /> :
    <Stack spacing={2} sx={{ width: "100%", maxWidth: 560 }}>
      <Typography variant="h6">New Chat</Typography>
      <Typography sx={{ overflowWrap: "anywhere" }}>{folder ?? "Automatic working folder"}</Typography>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button variant="contained" disabled={browsing} onClick={() => void create()}>Create Chat</Button>
        <Button onClick={() => setBrowsing(value => !value)}>{browsing ? "Close folder picker" : "Choose working folder"}</Button>
        {folder ? <Button onClick={() => { setFolder(undefined); setBrowsing(false); }}>Use automatic folder</Button> : null}
      </Stack>
      {browsing ? <Stack spacing={1} alignItems="flex-start">
        {folders.isPending ? <CircularProgress size={20} aria-label="Loading host folders" /> : null}
        {folders.error ? <Alert severity="error">{folders.error.message}</Alert> : null}
        {folders.data ? <>
          <Typography sx={{ overflowWrap: "anywhere" }}>{folders.data.path}</Typography>
          <Button onClick={() => { setFolder(folders.data.path); setBrowsing(false); }}>Use this folder</Button>
          {folders.data.parentPath ? <Button onClick={() => setBrowsePath(folders.data.parentPath)}>Parent folder</Button> : null}
          <Stack sx={{ maxHeight: 240, overflow: "auto" }} alignItems="flex-start">
            {folders.data.folders.map(entry => <Button key={entry.hostPath} onClick={() => setBrowsePath(entry.hostPath)}>{entry.name}</Button>)}
          </Stack>
        </> : null}
      </Stack> : null}
    </Stack> : <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Alert severity="error">{error}</Alert>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button disabled={busy || !enginesLoaded} onClick={() => void create()}>{busy ? "Opening…" : "Retry"}</Button>
        {canChangeFolder ? <Button disabled={busy} onClick={() => { setError(undefined); setBrowsing(true); }}>Choose another folder</Button> : null}
        {onConfigureProvider ? <Button disabled={busy} onClick={onConfigureProvider}>Provider Settings</Button> : null}
      </Stack>
    </Stack>}
    {onCancel ? <Button onClick={onCancel}>Back</Button> : null}
    </Stack>
  </Box>;
}
