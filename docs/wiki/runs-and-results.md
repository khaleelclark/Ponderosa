---
id: runs-and-results
title: Runs, work, and results
summary: Distinguish why an Agent runs, what the runtime emits, and which outputs remain durable.
section: Agents
order: 50
related: agents-and-organization,project-chat,triggers
code: Run scheduler|apps/server/src/coordination-v3-scheduler.ts;Execution events|packages/core/src/events.ts
assets: Workspace map|docs/wiki/assets/workspace-map.svg
---

An **Activation** is an actionable reason to wake an Agent. A **Run** is the bounded execution that consumes one or more compatible Activations. Only the scheduler creates and leases Runs; message handlers, provider adapters, and UI projections do not.

In Agent Activity, each user-, Agent-, or Trigger-initiated Run is a prominent top-level boundary. Scheduler Runs awakened by Join and coordination updates remain auditable as compact continuation markers beneath that work instead of repeating the original title as a new peer heading. Consecutive tool calls or commands collapse into one type-based summary and stop grouping when the activity type changes; expand the summary to inspect individual rows, then expand a row for its input, output, working directory, or failure evidence.

## Follow current work

The responding indicator and elapsed time come from canonical Run ownership. **Work log** contains completed ordinary response text and transient reasoning detail for that execution. **Activity** is a read-only chronological inspection stream that interleaves those response and reasoning segments with commands, tests, tools, browser operations, and file events at their canonical event sequence. Command and file-change events may carry the provider call ID so their later tool result can be paired without changing either event's communication scope. **Changed Files** is the Agent-attributed set, while **Review** may layer current Git working-tree state over that provenance.

Activity is execution telemetry, never Communication: it does not notify, become unread work, enter Project chat, or become future provider context.

## Keep results durable

Files & results contains managed Artifacts with their Project, Agent, and execution provenance. Long text above the inline limit becomes a stable Markdown artifact rather than being copied through every later prompt. A message may reference the artifact's stable ID; authorized Agents retrieve the body only when the current work needs it.

The Project overview gathers existing rules, attention signals, active work, pinned or published outputs, and usage links without creating another status record. **Why this Run started** opens the corresponding Agent Work trace, while the Run card lists the structured provider-input sources before offering the sensitive exact prompt.

## Continue across a fresh provider session

An Agent that deliberately needs a fresh provider session can submit one bounded continuation handoff. Ponderosa accepts it only from the active Run, retires the old provider runtime after that Run succeeds, and includes the handoff once in the next fresh seed as non-authoritative background. Failed or cancelled source Runs cannot make a handoff eligible. Canonical messages, Requests, Decisions, artifacts, and Project rules remain the source of truth; `/fresh` starts a fresh session without inventing a handoff.

## Stop the exact Run

Cancellation targets the exact Run ID the operator observed. An accepted stop immediately fences the execution and interrupts its provider process. A delayed retry cannot cancel a successor Run. Later queued work remains eligible, while the cancelled Activation is never silently respawned.
