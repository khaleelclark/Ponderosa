import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ChatFolderDto, WorkspaceNotificationProjectionDto } from "@ponderosa/core";
import { useSyncExternalStore } from "react";
import { api } from "../api";
import { AGENT_DETAIL_PAGE_SIZE } from "../agentHistoryPagination";
import { queryKeys } from "../queryKeys";
import { WorkspacePreferencesWriter } from "../workspacePreferencesWriter";
import {changedWorkspaceDirectoryKinds} from '../resourcePreferences';

const workspacePreferenceWriters = new WeakMap<QueryClient, WorkspacePreferencesWriter>();

/** Product shells share the canonical preference queue and conflict rebase. */
export function useWorkspacePreferencesWriter():WorkspacePreferencesWriter {
  const client=useQueryClient();
  let writer=workspacePreferenceWriters.get(client);
  if(!writer){
    writer=new WorkspacePreferencesWriter({read:()=>client.getQueryData(queryKeys.workspacePreferences.all),publish:value=>client.setQueryData(queryKeys.workspacePreferences.all,value),write:patch=>api.updateWorkspacePreferences(patch),refresh:()=>api.getWorkspacePreferences(),onSuccess:(previous,value,patch)=>{
      for(const kind of changedWorkspaceDirectoryKinds(previous,value))void client.invalidateQueries({queryKey:queryKeys.workspaceDirectory.kind(kind)});
      void client.invalidateQueries({queryKey:['branches']});
      if(patch.starredResourceIds!==undefined||patch.starredProjectIds!==undefined)void client.invalidateQueries({queryKey:queryKeys.workspaceResourceRecency.all});
      if(patch.claudeModelOptions!==undefined){void client.invalidateQueries({queryKey:queryKeys.engines.all});void client.invalidateQueries({queryKey:['engine-models']});}
    }});
    workspacePreferenceWriters.set(client,writer);
  }
  return writer;
}

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => api.listProjects(),
  });
}

export function useWorkspacePreferences(writer?: WorkspacePreferencesWriter) {
  const queryClient = useQueryClient();
  if (writer) workspacePreferenceWriters.set(queryClient, writer);
  return useQuery({
    queryKey: queryKeys.workspacePreferences.all,
    queryFn: () => {
      const activeWriter = workspacePreferenceWriters.get(queryClient);
      return activeWriter
        ? activeWriter.fetchCanonical(() => api.getWorkspacePreferences())
        : api.getWorkspacePreferences();
    },
  });
}

interface NotificationFetchRevisionStore {
  getSnapshot(): number;
  subscribe(listener: () => void): () => void;
}

const notificationFetchRevisionStores = new WeakMap<QueryClient, NotificationFetchRevisionStore>();

function notificationFetchRevisionStore(queryClient: QueryClient): NotificationFetchRevisionStore {
  const existing = notificationFetchRevisionStores.get(queryClient);
  if (existing) return existing;
  let revision = 0;
  const listeners = new Set<() => void>();
  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      event.action.manual ||
      event.query.queryKey.length !== queryKeys.notifications.all.length ||
      event.query.queryKey.some((part: unknown, index: number) => part !== queryKeys.notifications.all[index])
    ) return;
    revision += 1;
    listeners.forEach((listener) => listener());
  });
  const store = {
    getSnapshot: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  notificationFetchRevisionStores.set(queryClient, store);
  return store;
}

export function useNotifications() {
  const queryClient = useQueryClient();
  const revisionStore = notificationFetchRevisionStore(queryClient);
  const successfulFetchRevision = useSyncExternalStore(
    revisionStore.subscribe,
    revisionStore.getSnapshot,
    revisionStore.getSnapshot,
  );
  const query = useQuery({ queryKey: queryKeys.notifications.all, queryFn: () => api.listNotifications() });
  return {
    ...query,
    successfulFetchRevision,
    getSuccessfulFetchRevision: revisionStore.getSnapshot,
  };
}

const NOTIFICATION_PROJECTION_SCOPE_BATCH_SIZE = 200;

function scopeBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += NOTIFICATION_PROJECTION_SCOPE_BATCH_SIZE) {
    batches.push(ids.slice(index, index + NOTIFICATION_PROJECTION_SCOPE_BATCH_SIZE));
  }
  return batches;
}

/** Fetch exact notification counts in resource-bounded batches. Each response
 * contains only scalar summaries for requested scopes, never notification rows. */
export function useNotificationProjection(
  projectIds: readonly string[],
  conversationIds: readonly string[],
  chatFolders: ReadonlyArray<Pick<ChatFolderDto, "id" | "conversationIds">> = [],
  enabled = true,
) {
  const normalizedProjectIds = [...new Set(projectIds)].sort();
  const normalizedFolders = chatFolders.map(folder => ({ id: folder.id, conversationIds: [...new Set(folder.conversationIds)].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const grouped = new Set(normalizedFolders.flatMap(folder => folder.conversationIds));
  const normalizedConversationIds = [...new Set(conversationIds)].filter(id => !grouped.has(id)).sort();
  return useQuery({
    enabled,
    queryKey: queryKeys.notifications.projection(
      normalizedProjectIds,
      normalizedConversationIds,
      JSON.stringify(normalizedFolders),
    ),
    queryFn: async ({ signal }): Promise<WorkspaceNotificationProjectionDto> => {
      const projectBatches = scopeBatches(normalizedProjectIds);
      const conversationBatches = scopeBatches(normalizedConversationIds);
      // Preferences already cap folder membership at 10,000 IDs overall.
      const folderBatches = Array.from({ length: Math.ceil(normalizedFolders.length / 200) }, (_, index) => normalizedFolders.slice(index * 200, (index + 1) * 200));
      const requestCount = Math.max(projectBatches.length, conversationBatches.length, folderBatches.length, 1);
      const pages: WorkspaceNotificationProjectionDto[] = new Array(requestCount);
      let next = 0;
      let failed = false;
      const worker = async () => {
        while (!failed && !signal.aborted && next < requestCount) {
          const index = next++;
          try {
            pages[index] = await api.getNotificationProjection({
              projectIds: projectBatches[index] ?? [],
              conversationIds: conversationBatches[index] ?? [],
              ...(folderBatches[index]?.length ? { chatFolders: folderBatches[index] } : {}),
            }, signal);
          } catch (error) { failed = true; throw error; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(requestCount, 2) }, worker));
      signal.throwIfAborted();
      const first = pages[0]!;
      return {
        workspace: first.workspace,
        inbox: first.inbox,
        projects: Object.assign({}, ...pages.map(page => page.projects)),
        conversations: Object.assign({}, ...pages.map(page => page.conversations)),
        chatFolders: Object.fromEntries(pages.flatMap(page => Object.entries(page.chatFolders ?? {}))),
      };
    },
  });
}

export function useInbox(limit = 50) {
  return useQuery({
    queryKey: queryKeys.inbox(limit),
    queryFn: () => api.getInbox(limit),
  });
}

export function useConversations(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.conversations.project(projectId),
    queryFn: () => api.listConversations(projectId ?? ""),
    enabled: Boolean(projectId) && enabled,
  });
}

export function useAgentHealth(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agents.health(projectId),
    queryFn: () => api.getAgentHealth(projectId ?? ""),
    enabled: Boolean(projectId) && enabled,
    refetchInterval: (query) => {
      const agents = query.state.data?.agents ?? [];
      return agents.some((agent) => agent.status === "running" || agent.status === "preparing" || agent.status === "waiting" || agent.status === "compacting")
        ? 5_000 : 30_000;
    },
  });
}

export function useConversation(conversationId: string | undefined, limit = 100, poll = true) {
  return useQuery({
    queryKey: queryKeys.conversations.detail(conversationId, limit),
    queryFn: () => api.getConversation(conversationId ?? "", limit),
    enabled: Boolean(conversationId),
    // SSE remains the prompt path. A mounted-Chat fallback keeps a missed
    // delivery/reply event from leaving the visible timeline stale. Only a
    // recently active Chat uses the five-second cadence; old receipts cannot
    // hold every open tab on that cadence forever.
    refetchInterval: query => {
      if (!poll) return false;
      const messages = query.state.data?.messages ?? [];
      const newest = messages.at(-1);
      const recent = newest && Date.now() - Date.parse(newest.createdAt) < 120_000;
      return recent ? 5_000 : 15_000;
    },
  });
}

export function useCollaborationView(conversationId: string | undefined, limit = 100, enabled = true) {
  return useQuery({
    queryKey: queryKeys.collaboration(conversationId, limit),
    queryFn: () => api.getCollaborationView(conversationId ?? "", limit),
    enabled: Boolean(conversationId) && enabled,
  });
}

export function useAgents(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agents.project(projectId),
    queryFn: () => api.listAgents(projectId ?? ""),
    enabled: Boolean(projectId) && enabled,
    // The query follows every server page so no first-page snapshot becomes
    // authoritative. Agent health provides the high-frequency live status path.
    refetchInterval: 30_000,
  });
}
export function useAgentPresets(projectId: string | undefined) {
  return useQuery({ queryKey: queryKeys.agents.presets(projectId), queryFn: () => api.listAgentPresets(projectId ?? ""), enabled: Boolean(projectId) });
}

export function useAgent(
  agentId: string | undefined,
  limit = AGENT_DETAIL_PAGE_SIZE,
) {
  return useQuery({
    queryKey: queryKeys.agents.detail(agentId, limit),
    queryFn: () => api.getAgent(agentId ?? "", limit),
    enabled: Boolean(agentId),
  });
}

export function useEngines() {
  return useQuery({
    queryKey: queryKeys.engines.all,
    queryFn: () => api.listEngines(),
  });
}
