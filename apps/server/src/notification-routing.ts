import type {
  CommunicationEvent,
  NotificationPreference,
  NotificationPreferencesDto,
  WorkspaceEvent,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import type { LogEvent } from "@ponderosa/agents";

/**
 * The workspace stream is a coarse invalidation bus, not a second copy of every
 * agent's execution stream. High-frequency output stays on the per-agent SSE
 * channel and in the canonical agent log.
 */
export function workspaceAgentEventCategory(event: LogEvent): Extract<WorkspaceEvent, { type: "agent_event" }>["category"] | undefined {
  switch (event.type) {
    case "agent_lifecycle": return "lifecycle";
    case "file_change": return "file";
    case "command":
    case "work_item_update":
    case "test_result":
    case "browser_session":
    case "browser_action":
    case "browser_console":
    case "context_rollover_triggered":
    case "context_rollover_seed_overflow":
    case "context_rollover_completed": return "task";
    case "browser_screenshot": return "artifact";
    case "session":
    case "session_reset": return "state";
    case "communication_projection": return "message";
    default: return undefined;
  }
}

export function notificationKindForCommunication(event: CommunicationEvent): WorkspaceNotificationDto["kind"] | undefined {
  if (event.sender.kind !== "agent") return undefined;
  if (event.intent === "broadcast") return "broadcasts";
  if (event.schemaVersion === 2 && event.intent === "user_dm") return "direct_responses";
  if (event.audienceSelector === "everyone") return "everyone";
  if (event.intent === "collaboration") return "collaboration";
  return undefined;
}

export function notificationPreferenceMatches(
  preference: NotificationPreference | NotificationPreferencesDto,
  event: CommunicationEvent,
  kind: WorkspaceNotificationDto["kind"],
): boolean {
  if (typeof preference === "object") {
    if (preference.allMessages) return true;
    if (kind === "direct_responses") return preference.directReplies;
    if (kind === "project_responses") return preference.projectChatMessages && event.intent === "broadcast" && Boolean(event.conversationId);
    if (kind === "broadcasts" || kind === "everyone") return preference.broadcasts;
    if (kind === "mentions") return preference.mentions;
    return false;
  }
  if (preference === "none") return false;
  if (preference === "all_messages") return true;
  if (preference === "project_responses") return event.intent === "broadcast" && Boolean(event.conversationId);
  // #user is represented structurally as an agent-to-user DM, never inferred
  // from rendered text. It is the only current communication that mentions the operator.
  if (preference === "mentions") return kind === "direct_responses";
  return preference === kind;
}
