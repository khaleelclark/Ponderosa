// Pure projectors (SPEC §4/§5). A LogEvent stream is folded into a list of
// projection ops; the store applies them to SQLite. Being pure + deterministic
// (ids from seq, timestamps from the event's own ts) is what makes a rebuild
// byte-identical to the incremental projection.
//
// Routing (SPEC §5, AGENTS.md invariant 3 — Chat is human-facing only):
//   user_message → messages (role user)            ← Chat
//   text         → events index ONLY                 ← transient Work log detail
//   agent_output → events index ONLY                 ← durable Work log response
//   reasoning    → events index ONLY (NOT Chat)     ← transient Work log detail
//   agent_lifecycle → Runs
//   command      → Run activity + Artifact
//   file_change  → Run activity + Artifact
//   test_result  → Run activity + Artifact
//   browser_*   → Run activity; explicit screenshots → Artifact
//   work_item_update → optional engine-reported Work item
//   session      → agent's active engine session id column
//   turn_done    → events index only; lifecycle owns Run terminal state
//   * (all)      → events index row (searchable log)
//
// Only explicit communication events may create a Chat projection. Runtime text
// and reasoning remain scoped to their originating execution.

import type { AgentLifecycleReason, AgentRunStatus, TokenUsage } from "@ponderosa/core";
import { artifactId, eventRowId, messageId, workItemId } from "./ids.js";
import type { StoredLogEvent } from "./log-event.js";
import type {
  ArtifactRow,
  EventRow,
  MessageRow,
  RunRow,
  WorkItemRow,
} from "./schema.js";

export type ProjectionOp =
  | { kind: "insert_message"; row: MessageRow }
  | { kind: "insert_run"; row: RunRow }
  | { kind: "update_run"; id: string; status: AgentRunStatus; reason: AgentLifecycleReason; updatedAt: string; completedAt?: string }
  | { kind: "set_run_usage"; id: string; inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number; providerRequestUsage?: TokenUsage[] }
  | { kind: "insert_work_item"; row: WorkItemRow }
  | { kind: "insert_artifact"; row: ArtifactRow; content?: string }
  | { kind: "insert_event"; row: EventRow }
  | { kind: "set_session"; sessionId: string | null }
  | { kind: "set_state"; branch?: string; commit?: string }
  | { kind: "touch_agent"; updatedAt: string };

export interface ProjectionState {
  activeEngine: string;
  activeExecutionId?: string;
  pendingRunTitle: string;
  pendingCommunicationEventId?: string;
}

export function initProjectionState(activeEngine: string): ProjectionState {
  return { activeEngine, pendingRunTitle: "Run" };
}

function truncate(s: string, n = 80): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function artifactPath(seq: number, suffix: string): string {
  return `${String(seq).padStart(6, "0")}-${suffix}`;
}

/**
 * Project one stored event. Returns the (possibly mutated) state and the ops to
 * apply. Pure: no I/O, no clock, no randomness.
 */
export function projectEvent(
  agentId: string,
  state: ProjectionState,
  stored: StoredLogEvent,
): { state: ProjectionState; ops: ProjectionOp[] } {
  const { seq, ts, event } = stored;
  const ops: ProjectionOp[] = [];
  let next = state;

  // Every event lands in the searchable index.
  ops.push({
    kind: "insert_event",
    row: {
      id: eventRowId(agentId, seq),
      agentId,
      seq,
      type: event.type,
      payloadJson: JSON.stringify(event),
      createdAt: ts,
    },
  });

  switch (event.type) {
    case "user_message": {
      ops.push({
        kind: "insert_message",
        row: {
          id: messageId(agentId, seq),
          communicationEventId: event.communicationEventId ?? null,
          agentId,
          seq,
          role: "user",
          text: event.text,
          createdAt: ts,
          replyToJson: event.replyTo ? JSON.stringify(event.replyTo) : null,
          attachmentsJson: event.attachments?.length ? JSON.stringify(event.attachments) : null,
        },
      });
      next = {
        ...next,
        pendingRunTitle: truncate(event.text) || "Run",
        pendingCommunicationEventId: event.communicationEventId,
      };
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "text":
    case "agent_output":
      // Ordinary runtime output is execution data, never an inferred message.
      break;

    case "communication_projection": {
      ops.push({
        kind: "insert_message",
        row: {
          id: messageId(agentId, seq),
          communicationEventId: event.communicationEventId,
          agentId,
          seq,
          role: event.role ?? "assistant",
          text: event.text,
          createdAt: ts,
          replyToJson: null,
          attachmentsJson: event.attachments?.length ? JSON.stringify(event.attachments) : null,
        },
      });
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "reasoning":
      // Intentionally not projected to Chat (see NOTE). Events index only.
      break;

    case "session":
      ops.push({ kind: "set_session", sessionId: event.sessionId });
      break;

    case "session_reset":
      ops.push({ kind: "set_session", sessionId: null });
      break;

    case "agent_lifecycle": {
      if (event.status === "running") {
        ops.push({
          kind: "insert_run",
          row: {
            id: event.executionId,
            agentId,
            title: next.pendingRunTitle,
            status: event.status,
            reason: event.reason,
            engine: next.activeEngine,
            model: event.model ?? null,
            effort: event.effort ?? null,
            communicationEventId: next.pendingCommunicationEventId ?? null,
            wakeCause: event.wakeCause ?? null,
            inputTokens: null,
            cachedInputTokens: null,
            cacheWriteInputTokens: null,
            outputTokens: null,
            reasoningOutputTokens: null,
            totalTokens: null,
            providerRequestUsageJson: null,
            startedAt: ts,
            updatedAt: ts,
            completedAt: null,
          },
        });
        next = { ...next, activeExecutionId: event.executionId, pendingCommunicationEventId: undefined };
      } else {
        ops.push({
          kind: "update_run",
          id: event.executionId,
          status: event.status,
          reason: event.reason,
          updatedAt: ts,
          ...(["cancelled", "completed", "failed", "interrupted"].includes(event.status) ? { completedAt: ts } : {}),
        });
        if (next.activeExecutionId === event.executionId && ["cancelled", "completed", "failed", "interrupted"].includes(event.status)) {
          next = { ...next, activeExecutionId: undefined };
        }
      }
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "command": {
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(agentId, seq, 0),
          agentId,
          executionId: next.activeExecutionId ?? null,
          kind: "log",
          path: artifactPath(seq, "command.md"),
          summary: event.command,
          createdAt: ts,
        },
        content: `# Command\n\n\`\`\`bash\n${event.command}\n\`\`\`\n\ncwd: \`${event.cwd}\`\n`,
      });
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "file_change": {
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(agentId, seq, 0),
          agentId,
          executionId: next.activeExecutionId ?? null,
          kind: "diff",
          path: artifactPath(seq, "diff.patch"),
          summary: `${event.kind} ${event.path}`,
          createdAt: ts,
        },
        content:
          event.diff ??
          `# ${event.kind} ${event.path}\n\nNo diff text was provided by the engine.\n`,
      });
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "test_result": {
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(agentId, seq, 0),
          agentId,
          executionId: next.activeExecutionId ?? null,
          kind: "test_report",
          path: artifactPath(seq, "test.md"),
          summary: `${event.passed ? "pass" : "fail"}: ${event.summary}`,
          createdAt: ts,
        },
        content: `# Test Result\n\nStatus: ${event.passed ? "passed" : "failed"}\n\n${event.summary}\n`,
      });
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "browser_screenshot": {
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(agentId, seq, 0),
          agentId,
          executionId: event.executionId,
          kind: "screenshot",
          path: event.path,
          summary: `Browser screenshot (${event.width}×${event.height})`,
          createdAt: ts,
        },
      });
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "generated_artifact": {
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(agentId, seq, 0), agentId, executionId: event.executionId,
          kind: "generated_file", path: event.path, summary: event.name, createdAt: ts,
        },
      });
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "browser_session":
    case "browser_action":
    case "browser_console":
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;

    case "work_item_update": {
      const id = workItemId(agentId, event.workItemId);
      ops.push({
        kind: "insert_work_item",
        row: {
          id,
          agentId,
          executionId: event.executionId ?? next.activeExecutionId ?? null,
          title: event.title ?? "Work item",
          status: event.status,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      break;
    }

    case "turn_done": {
      if (event.usage && (event.executionId ?? next.activeExecutionId)) {
        ops.push({
          kind: "set_run_usage",
          id: event.executionId ?? next.activeExecutionId!,
          ...event.usage,
          ...(event.providerRequestUsage ? { providerRequestUsage: event.providerRequestUsage } : {}),
        });
      }
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    case "error": {
      ops.push({ kind: "touch_agent", updatedAt: ts });
      break;
    }

    // tool_call / tool_result: timeline detail, lives in the events index only.
    default:
      break;
  }

  return { state: next, ops };
}

/** Fold a full log into ops (used by rebuild and tests). */
export function projectAll(
  agentId: string,
  storedEvents: StoredLogEvent[],
  activeEngine: string,
): ProjectionOp[] {
  let state = initProjectionState(activeEngine);
  const ops: ProjectionOp[] = [];
  for (const stored of storedEvents) {
    const res = projectEvent(agentId, state, stored);
    state = res.state;
    ops.push(...res.ops);
  }
  return ops;
}
