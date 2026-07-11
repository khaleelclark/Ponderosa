import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
}

export function useMasterChats(projectId: string | undefined) {
  return useQuery({
    queryKey: ["master-chats", projectId],
    queryFn: () => api.listMasterChats(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

export function useMasterChat(masterChatId: string | undefined) {
  return useQuery({
    queryKey: ["master-chat", masterChatId],
    queryFn: () => api.getMasterChat(masterChatId ?? ""),
    enabled: Boolean(masterChatId),
    // The group chat is the primary surface: poll so agent report-backs and new
    // agents appear without a manual refresh.
    refetchInterval: 4000,
  });
}

export function useCollaborationChat(masterChatId: string | undefined) {
  return useQuery({
    queryKey: ["collaboration-chat", masterChatId],
    queryFn: () => api.getCollaborationChat(masterChatId ?? ""),
    enabled: Boolean(masterChatId),
    refetchInterval: 4000,
  });
}

export function useThreads(projectId: string | undefined) {
  return useQuery({
    queryKey: ["threads", projectId],
    queryFn: () => api.listThreads(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

export function useThread(threadId: string | undefined) {
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => api.getThread(threadId ?? ""),
    enabled: Boolean(threadId),
  });
}

export function useEngines() {
  return useQuery({
    queryKey: ["engines"],
    queryFn: () => api.listEngines(),
  });
}
