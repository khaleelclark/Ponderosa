import { Alert, Box, Button, CircularProgress, Stack } from "@mui/material";
import type { ConversationDto, CreateProjectRequest, EngineDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { definitiveSubmissionStatus } from "./idempotentAttempt";
import { resolveConversationEngine } from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { ensureCreationAttemptPersisted, readCreationAttempts, saveCreationAttempts, type ChatCreationAttempt } from "./chatCreationAttempts";

/** A transient entry, not a setup screen: persist an empty Chat, then open its
 * normal workspace. The route identity survives refresh and exact retries. */
export function NewChatComposer({ creationKey, engines, enginesLoaded = true, onCreated, onCancel, onConfigureProvider, onPendingChange }: {
  creationKey?: string;
  engines: EngineDto[]; enginesLoaded?: boolean; preferences: WorkspacePreferencesDto;
  onCreated(projectId: string, conversationId: string): void;
  onCancel?(): void;
  onConfigureProvider?(): void;
  onPendingChange?(pending: boolean): void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  const autoStarted = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { onPendingChange?.(busy); }, [busy, onPendingChange]);
  const retire = (key: string) => {
    // A late response must not overwrite another + click's newer journal entry.
    const next = readCreationAttempts().filter(item => item.key !== key);
    saveCreationAttempts(next);
  };
  const open = (chat: Pick<ConversationDto, "id" | "projectId">) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all }).catch(() => {});
    if (mounted.current) onCreated(chat.projectId, chat.id);
  };
  const create = async (retry?: ChatCreationAttempt) => {
    if (locked.current || !creationKey) return;
    const saved = retry ?? readCreationAttempts().find(item => item.key === creationKey);
    const engineId = resolveConversationEngine(undefined, engines);
    if (!saved && !engineId) {
      setError("No provider is configured. Configure a provider, then open a new Chat.");
      return;
    }
    // The server resolves advertised defaults into the saved Chat. Its normal
    // composer shows/edits that exact tuple; old form values are never reused.
    const current: ChatCreationAttempt = saved ?? {
      key: creationKey,
      input: { label: "New Chat", defaultEngine: engineId as CreateProjectRequest["defaultEngine"] },
    };
    if (!ensureCreationAttemptPersisted(current)) {
      setError("Browser storage is unavailable. Enable it so an unconfirmed Chat creation can be retried safely.");
      return;
    }
    locked.current = true; setBusy(true); setError(undefined);
    try {
      const chat = await api.createChat(current.input, current.key);
      // History/settings can revisit a committed key even after navigation.
      // Keep its exact original input and a completion receipt, not a new tuple.
      const journal = readCreationAttempts();
      const completed = { ...current, chat: { id: chat.id, projectId: chat.projectId } };
      if (!saveCreationAttempts([...journal.filter(item => item.key !== current.key), completed])) {
        // The already-persisted original attempt remains safe for exact replay.
        if (mounted.current) setError("Chat was saved, but its local receipt could not be saved. Retry to open the same Chat.");
        return;
      }
      open(chat);
    } catch (failure) {
      const definite = failure instanceof ApiRequestError && definitiveSubmissionStatus(failure.status, failure.message) &&
        !(failure.status === 409 && /reused|replay conflict/iu.test(failure.message));
      if (definite && !current.chat) retire(current.key);
      if (mounted.current) setError(`${failure instanceof Error ? failure.message : String(failure)}${definite
        ? " Correct the provider settings and retry."
        : " Creation is unconfirmed. Retry to open the same Chat if it was created."}`);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!creationKey || !enginesLoaded || autoStarted.current) return;
    autoStarted.current = true;
    void create();
  }, [creationKey, enginesLoaded, engines]);
  return <Box sx={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", p: 2 }}>
    <Stack spacing={2} alignItems="center">
    {!error ? <CircularProgress size={24} aria-label="Opening New Chat" /> : <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Alert severity="error">{error}</Alert>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button disabled={busy || !enginesLoaded} onClick={() => void create()}>{busy ? "Opening…" : "Retry"}</Button>
        {onConfigureProvider ? <Button disabled={busy} onClick={onConfigureProvider}>Provider settings</Button> : null}
      </Stack>
    </Stack>}
    {onCancel ? <Button onClick={onCancel}>Back</Button> : null}
    </Stack>
  </Box>;
}
