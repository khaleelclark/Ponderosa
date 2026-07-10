// Agent = a Thread, presented to the user. This module centralizes the
// user-facing status vocabulary so the Agents tab, sidebar, and detail view
// stay consistent. The underlying data model remains ThreadDto/ThreadDetailDto.

import type { TaskDto, ThreadDetailDto } from "@ponderosa/core";

export type AgentStatus = "running" | "waiting" | "completed" | "error" | "idle";

export interface AgentLiveHints {
  /** Live SSE run in progress for this agent. */
  running?: boolean;
  /** The last streamed event was an error. */
  error?: boolean;
}

/**
 * Derive the coarse agent status shown in lists and filters from the thread's
 * tasks plus any live-stream hints. Live hints win over projected task state so
 * a running agent reads as running the instant the stream reports it.
 */
export function deriveAgentStatus(
  detail: ThreadDetailDto | undefined,
  hints: AgentLiveHints = {},
): AgentStatus {
  if (hints.running) {
    return "running";
  }
  const tasks = detail?.tasks ?? [];
  if (tasks.some((task) => task.status === "running")) {
    return "running";
  }
  if (tasks.some((task) => task.status === "waiting_approval")) {
    return "waiting";
  }
  if (hints.error) {
    return "error";
  }
  if (tasks.length > 0 && tasks.every((task) => task.status === "done")) {
    return "completed";
  }
  return "idle";
}

export function agentStatusLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

export function agentStatusColor(
  status: AgentStatus,
): "success" | "warning" | "info" | "error" | "default" {
  switch (status) {
    case "running":
      return "info";
    case "waiting":
      return "warning";
    case "completed":
      return "success";
    case "error":
      return "error";
    default:
      return "default";
  }
}

/** Short "current task or latest activity" line for an agent row. */
export function agentActivity(detail: ThreadDetailDto | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const activeTask = [...detail.tasks]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .find((task: TaskDto) => task.status !== "done");
  if (activeTask) {
    return activeTask.title;
  }
  const lastTask = [...detail.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (lastTask) {
    return lastTask.title;
  }
  const lastMessage = detail.messages.at(-1);
  return lastMessage?.text.slice(0, 80);
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
