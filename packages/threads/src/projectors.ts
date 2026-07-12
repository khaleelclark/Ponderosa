// Pure projectors (SPEC §4/§5). A LogEvent stream is folded into a list of
// projection ops; the store applies them to SQLite. Being pure + deterministic
// (ids from seq, timestamps from the event's own ts) is what makes a rebuild
// byte-identical to the incremental projection.
//
// Routing (SPEC §5, AGENTS.md invariant 3 — Chat is human-facing only):
//   user_message → messages (role user)            ← Chat
//   text         → messages (role assistant)        ← Chat
//   reasoning    → events index ONLY (NOT Chat)     ← kept clean; see NOTE
//   command      → Tasks (timeline) + task lifecycle
//   file_change  → Tasks + Artifacts (a diff artifact)
//   test_result  → Tasks + Artifacts (a test_report artifact)
//   task_update  → Tasks (explicit status, if an engine emits it)
//   session      → thread's active engine session id column
//   turn_done    → close the current task (done)
//   * (all)      → events index row (searchable log)
//
// NOTE on reasoning: SPEC §5 lists reasoning alongside text as "→ Chat", but
// AGENTS.md invariant 3 says Chat holds intent/conversation only. We resolve the
// tension by NOT projecting reasoning into the durable Chat (messages) table — it
// stays in the queryable events index and can be rendered live/secondary by the UI.
// Recorded in CONTRACTS/README.

import type { TaskStatus } from "@ponderosa/core";
import { artifactId, eventRowId, messageId, taskId } from "./ids.js";
import type { StoredLogEvent } from "./log-event.js";
import type {
  ArtifactRow,
  EventRow,
  MessageRow,
  TaskRow,
} from "./schema.js";

export type ProjectionOp =
  | { kind: "insert_message"; row: MessageRow }
  | { kind: "insert_task"; row: TaskRow }
  | { kind: "update_task"; id: string; status: TaskStatus; updatedAt: string }
  | { kind: "insert_artifact"; row: ArtifactRow; content?: string }
  | { kind: "insert_event"; row: EventRow }
  | { kind: "set_session"; sessionId: string | null }
  | { kind: "set_state"; branch?: string; commit?: string }
  | { kind: "touch_thread"; updatedAt: string };

export interface ProjectionState {
  activeEngine: string;
  /** seq of the user_message opening the current run (the task id key). */
  currentRunSeq?: number;
  /** Title for the current run's task (from the opening user message). */
  currentRunTitle: string;
  /** Whether a task row has been created for the current run yet. */
  taskCreated: boolean;
}

export function initProjectionState(activeEngine: string): ProjectionState {
  return { activeEngine, currentRunTitle: "Task", taskCreated: false };
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
  threadId: string,
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
      id: eventRowId(threadId, seq),
      threadId,
      seq,
      type: event.type,
      payloadJson: JSON.stringify(event),
      createdAt: ts,
    },
  });

  // Ensure a task exists for the current run; returns its id + appends create op.
  const ensureTask = (): string => {
    const runSeq = next.currentRunSeq ?? seq;
    if (next.currentRunSeq === undefined) {
      next = { ...next, currentRunSeq: runSeq };
    }
    const id = taskId(threadId, runSeq);
    if (!next.taskCreated) {
      ops.push({
        kind: "insert_task",
        row: {
          id,
          threadId,
          title: next.currentRunTitle,
          status: "running",
          engine: next.activeEngine,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      next = { ...next, taskCreated: true };
    }
    return id;
  };

  switch (event.type) {
    case "user_message": {
      ops.push({
        kind: "insert_message",
        row: {
          id: messageId(threadId, seq),
          communicationEventId: null,
          threadId,
          seq,
          role: "user",
          text: event.text,
          createdAt: ts,
          replyToJson: event.replyTo ? JSON.stringify(event.replyTo) : null,
          attachmentsJson: event.attachments?.length ? JSON.stringify(event.attachments) : null,
        },
      });
      // A user message opens a new run.
      next = {
        ...next,
        currentRunSeq: seq,
        currentRunTitle: truncate(event.text) || "Task",
        taskCreated: false,
      };
      ops.push({ kind: "touch_thread", updatedAt: ts });
      break;
    }

    case "text": {
      if (event.delta.trim() !== "") {
        ops.push({
          kind: "insert_message",
          row: {
            id: messageId(threadId, seq),
            communicationEventId: null,
            threadId,
            seq,
            role: "assistant",
            text: event.delta,
            createdAt: ts,
            replyToJson: null,
            attachmentsJson: null,
          },
        });
        ops.push({ kind: "touch_thread", updatedAt: ts });
      }
      break;
    }

    case "communication_projection": {
      ops.push({
        kind: "insert_message",
        row: {
          id: messageId(threadId, seq),
          communicationEventId: event.communicationEventId,
          threadId,
          seq,
          role: "assistant",
          text: event.text,
          createdAt: ts,
          replyToJson: null,
          attachmentsJson: null,
        },
      });
      ops.push({ kind: "touch_thread", updatedAt: ts });
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

    case "command": {
      const tId = ensureTask();
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(threadId, seq, 0),
          threadId,
          taskId: tId,
          kind: "log",
          path: artifactPath(seq, "command.md"),
          summary: event.command,
          createdAt: ts,
        },
        content: `# Command\n\n\`\`\`bash\n${event.command}\n\`\`\`\n\ncwd: \`${event.cwd}\`\n`,
      });
      ops.push({ kind: "touch_thread", updatedAt: ts });
      break;
    }

    case "file_change": {
      const tId = ensureTask();
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(threadId, seq, 0),
          threadId,
          taskId: tId,
          kind: "diff",
          path: artifactPath(seq, "diff.patch"),
          summary: `${event.kind} ${event.path}`,
          createdAt: ts,
        },
        content:
          event.diff ??
          `# ${event.kind} ${event.path}\n\nNo diff text was provided by the engine.\n`,
      });
      ops.push({ kind: "touch_thread", updatedAt: ts });
      break;
    }

    case "test_result": {
      const tId = ensureTask();
      ops.push({
        kind: "insert_artifact",
        row: {
          id: artifactId(threadId, seq, 0),
          threadId,
          taskId: tId,
          kind: "test_report",
          path: artifactPath(seq, "test.md"),
          summary: `${event.passed ? "pass" : "fail"}: ${event.summary}`,
          createdAt: ts,
        },
        content: `# Test Result\n\nStatus: ${event.passed ? "passed" : "failed"}\n\n${event.summary}\n`,
      });
      ops.push({ kind: "touch_thread", updatedAt: ts });
      break;
    }

    case "task_update": {
      // An engine that emits explicit task status (Codex doesn't in v1).
      ops.push({
        kind: "insert_task",
        row: {
          id: `${threadId}:t:${event.taskId}`,
          threadId,
          title: event.title ?? next.currentRunTitle,
          status: event.status,
          engine: next.activeEngine,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      break;
    }

    case "turn_done": {
      if (next.currentRunSeq !== undefined && next.taskCreated) {
        ops.push({
          kind: "update_task",
          id: taskId(threadId, next.currentRunSeq),
          status: "done",
          updatedAt: ts,
        });
      }
      next = { ...next, taskCreated: false, currentRunSeq: undefined };
      ops.push({ kind: "touch_thread", updatedAt: ts });
      break;
    }

    case "error": {
      if (next.currentRunSeq !== undefined && next.taskCreated) {
        ops.push({
          kind: "update_task",
          id: taskId(threadId, next.currentRunSeq),
          status: "done",
          updatedAt: ts,
        });
      }
      ops.push({ kind: "touch_thread", updatedAt: ts });
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
  threadId: string,
  storedEvents: StoredLogEvent[],
  activeEngine: string,
): ProjectionOp[] {
  let state = initProjectionState(activeEngine);
  const ops: ProjectionOp[] = [];
  for (const stored of storedEvents) {
    const res = projectEvent(threadId, state, stored);
    state = res.state;
    ops.push(...res.ops);
  }
  return ops;
}
