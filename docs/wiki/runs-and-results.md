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

## Follow current work

The responding indicator and elapsed time come from canonical Run ownership. **Work log** contains completed ordinary response text and transient reasoning detail for that execution. **Activity** shows commands, tests, tools, browser operations, and file events. **Changed Files** is the Agent-attributed set, while **Review** may layer current Git working-tree state over that provenance.

## Keep results durable

Files & results contains managed Artifacts with their Project, Agent, and execution provenance. Long text above the inline limit becomes a stable Markdown artifact rather than being copied through every later prompt. A message may reference the artifact's stable ID; authorized Agents retrieve the body only when the current work needs it.

## Stop the exact Run

Cancellation targets the exact Run ID the operator observed. An accepted stop immediately fences the execution and interrupts its provider process. A delayed retry cannot cancel a successor Run. Later queued work remains eligible, while the cancelled Activation is never silently respawned.
