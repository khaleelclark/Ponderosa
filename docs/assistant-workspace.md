# Assistant workspace actions and proactive checks

Assistant uses the same runtime tools as other Agents; designating a speaker does
not grant access. Human Settings control **Read project status**, **Create Chats**,
and **Start work across Projects** in the existing installation/product/Branch/
Chat/Agent/Run capability hierarchy. Unrestricted tools remain available by
default, as required by the human-access model. Destination product, Chat and
Agent restrictions also apply. Agent tools cannot edit these policies. Revoking
access is checked at each call, including an already-running provider session.
Memory, browser grants and communication-history retrieval are unchanged.

- `ponderosa_workspace_projects` returns at most 50 registered Chats with up to
  50 visible Agents each. Use the returned `afterId` while `hasMore` is true.
  Restricted Chats/Agents and execution-owned temporary resources are omitted.
- `ponderosa_workspace_create_chat` creates a managed empty Chat, with an explicit
  label, configured engine and idempotency key. It accepts no host path or access
  settings. A stable key recovers the original result; changed input conflicts.
- `ponderosa_workspace_start_work` takes a Chat ID, task text and stable key. Use
  an existing Agent ID, or a title/engine to create a tracked idle Agent. New Agent
  creation also respects the source managed-Agent creation restriction. The
  scheduler starts ordinary next-Run work; it never interrupts existing work.

Each mutation returns a durable `workspace_agent_actions` receipt with its source
Agent and Run. New Agents retain immutable spawner provenance. The destination
receives a system-authored `workspace-relay` Communication with the exact original
text and structured origin receipt; it does not impersonate a human or turn the
source Agent into a member of the destination Chat. A destination-scoped tracked Request, its next-Run activation, new Agent and
start receipt commit atomically. The worker completes that Request normally; a
subsequent Assistant check can report its canonical result. The host relay has no
cross-Chat peer reply route or fabricated human requester. Chat creation uses the existing durable managed
folder/Chat idempotency path. A Chat accepted before cancellation may finish
creation; its same-key receipt recovers the result without starting extra work.
Normal project/Chat deletion and provider admission remain authoritative.

## Proactive checks

Fresh default Assistant workflows run every ten minutes. Output Settings changes
the real workflow interval and automatic state. The default Step asks the speaker
to call `ponderosa_assistant_check`, then complete its workflow Request. It does
not require a user message when no useful changes exist. Human-edited workflows
are not silently rewritten; existing workflows can use the same tool/instructions.

The check reads explicit completed task results or explicit `taskDelivery: final`
communications, failed Runs and blocked/failed/unavailable/unknown task outcomes.
A successful provider Run alone is not claimed as completed work. Summaries retain
canonical evidence IDs, Project/Chat/Agent ownership and the original result text
(up to 300 characters per source). Only explicit result summaries and status fields enter the digest. It does not
infer project correctness or retrieve conversation histories, memory, arbitrary
host files or external issue trackers.

Only the current speaker can publish this digest. Source and destination read
settings are checked. Checks exclude the speaker's own outcomes to prevent its reports becoming new
report inputs; other Agents in the same Project remain eligible. A monotonic, trigger-maintained source index and durable cursor scan at most
200 source records, batch at most 50 changes and report backlog with `hasMore`.
The source index contains new canonical outcomes after this feature is installed.
New speaker designations start at the current source sequence; existing speakers
start with new outcomes observed since this feature was installed. Older historical
backlogs are not replayed, and equal/backward timestamps cannot skip new outcomes.
Events skipped while access is restricted are not reported later as new activity. New events after an explicit grant can be reported. Unchanged
sources never repeat after restart. New changes after a report wait until the
configured interval elapses, so repeated tool calls cannot flood the user.

Reports are ordinary canonical private replies from the speaker. The existing
notification journal applies global direct-response settings and Agent/Chat
all/attention/muted settings. Default settings create quiet unread activity with
no notification/tag; enabling relevant alerts creates the chosen notification.
Opening/marking the report read clears its unread projection. The tool's returned
publication receipt must not be echoed through another message tool.

## Verification and limits

`tests/branches/assistant-workspace.test.mjs` uses inert controlled adapters and the
real loopback server/scheduler to prove cross-project grant allow/deny, source
provenance, replay/conflicts, actual scheduled completion/issue reports, quiet
checks, configurable cadence, notification choices, repeated-call suppression,
restart deduplication and exact schema upgrade/refusal. It advances only the
fixture source's due marker rather than waiting ten real minutes.

This is the cross-project/action/report slice. No native audio/call latency,
real-provider inference, complete UI streaming, subjective panel acceptance,
API-key mode is qualified here. Portable output/speaker import review is covered
separately in [portable output roles](portable-output-roles.md).
Independent review and integrated-candidate checks remain required.

## Inbox rename

Inbox now names the feed's components, route kind, DTOs, API (`/api/inbox`), query
keys, source/reply helpers and projection methods. `/messages` remains the stable
browser entry point, and `messages:composer:*` saved-draft keys retain existing
user selections. Persisted SQL `all_chat_feed_projection` and its index names
remain intentionally stable storage identities, not product terminology. Reviewer-found banner, return-navigation, cursor-error and timeline accessibility
labels now use Inbox. One historical All Messages comment in
`Composer.types.ts` remains pending the composer owner; it is not rendered UI. Generic **All Chats** and
**All Agents** workspace nouns describe separate directory views and are unchanged.
