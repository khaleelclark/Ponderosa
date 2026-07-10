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
