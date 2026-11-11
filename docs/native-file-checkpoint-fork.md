# Native file checkpoints and transcript forks

G5 source implementation, researched 2026-11-01 from base
`04e8e60bb4975f2651ce8cb569ee2e5077ae1dc9`. Runtime qualification remains deferred.
Native file rewind, native transcript fork and Branch workflow restore are
separate operations. Neither native operation settles old Runs, Requests,
publication effects, grants, memory or unknown external work.

## Operator API and UI contract

These are operator REST routes, not managed Agent tools. Existing operator
origin/access rules apply. No provider credentials or arbitrary native paths are
accepted. The controls require an accepted idle retained runtime; active source
work, context recovery, paused Runs, deletion and changed identity refuse.

`GET /api/agents/:id/native-history` returns `boundary`, `boundaryHash`, `catalog`
and `held`. The boundary names Agent/Chat/Project, engine, native session,
completed source Run/fence, contract hash and working folder. The catalog lists
only selectable exact native checkpoint UUIDs and completed fork boundaries.
Render these returned values; do not derive IDs from timestamps or displayed text.

`POST /api/agents/:id/native-history` accepts these forms:

```json
{"operation":"preview","idempotencyKey":"preview-1","boundaryHash":"<GET hash>","checkpointId":"<selected UUID>"}
```

```json
{"operation":"rewind","idempotencyKey":"rewind-1","boundaryHash":"<same GET hash>","checkpointId":"<same UUID>","previewKey":"preview-1","acknowledgeFileChanges":true}
```

The preview calls native dry-run, retains its reported changed files/counts and
captures current bounded file/ancestor identities and bytes. Rewind requires a
matching preview no older than 60 seconds, unchanged file facts, writable host
policy, and no other active managed writer in the same folder. Paths outside
that folder, links/nonregular files, unavailable parents and oversized previews
refuse. The UI must show tracked files may be restored or deleted, while the
conversation and external effects remain unchanged. Display `canRewind`, errors
and `skippedLinks`; `completed` is a native response, not proof of full restore.
A native refusal with `canRewind:false` is not a successful file restoration.
Snapshots do not lock out independent host writers; this is a managed-writer
contract, not a guarantee against arbitrary concurrent shell/user edits.

For transcript fork, first create an empty Agent through the ordinary Agent
creation flow, in the same Chat, with the same engine and working folder. Then:

```json
{"operation":"fork","idempotencyKey":"fork-1","boundaryHash":"<GET hash>","throughId":"<selected completed native boundary>","targetAgentId":"<new empty Agent>","acknowledgeHistoryCopy":true}
```

This prepares a fresh destination context and holds the source against new
host-scheduled work. It does not invoke the provider or create a scheduler Run.
Send a **new human message** to the destination through normal Chat. That real
scheduler Run claims the prepared seed before provider open and creates the
native fork once. It receives fresh host system instructions, tool handlers,
access restrictions and capability token. Copied transcript/tool descriptions
are context; they do not authorize old tools, Requests, browsers or source leases.
The original session is not assigned to the destination. The native fork opens
under a new ID; normal completed-Run snapshot acceptance remains responsible for
accepting that context. The journal's `opened` state alone is not acceptance.

`GET /api/agents/:sourceId/native-history?key=<original key>` reads the durable
receipt, even after the retained runtime changes. An exact POST key replay
returns the original recorded state without resubmitting native input. Different
input with that key conflicts. After a lost HTTP response, inspect this key;
absence or HTTP failure does not establish that native mutation did not happen.
Reservations use the existing coordination idempotency table; no schema change.
`started` without a confirmed result remains held across restart and different
keys. There is no automatic retry or guessed lost-ACK recovery.

`POST /api/agents/:sourceId/native-history/cancel-preparation` with
`{"key":"fork-1"}` cancels only a still-`prepared` fork, before provider dispatch.
Started/unknown native operations cannot be cleared by this endpoint. A failed
or interrupted destination remains visible with its journal; do not replay the
fork into that Agent. Readback preserves the original source boundary, selected
cut, destination Run/fence and observed fresh native identity where available.

The UI labels should be “Preview tracked file rewind”, “Rewind tracked files”,
and “Fork transcript into new Agent”. They must remain distinct from Branch
checkpoint restore. Require the two explicit acknowledgements above; never
silently trigger either operation from a provider command or ordinary Agent text.
The dedicated web controls are an integration contract; this change supplies the
wired APIs and scheduler path, not a new web panel.

## Native protocol and limitations

Claude's official [checkpoint guide](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
limits tracking to supported editor tools, rather than arbitrary shell/subagent
writes. Rewind leaves conversation history intact. Historical backups are not
manufactured from transcript UUIDs. This implementation enables native tracking
at startup and retains up to 128 observed completed main-session UUIDs in the
live transport. Restarted/evicted transports do not invent the missing catalog.

The [SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) supplies
native dry-run/result fields and `forkSession` semantics; prior file checkpoints
do not transfer to the fork. The CLI path uses a fresh UUID with exact resume,
fork and message-cut flags; it does not import the SDK. File rewind is exposed
only after native generation 2.1.216 or newer is observed, preserving link safety.
The pinned official [transport](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)
sets `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`. Its [control implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/query.py)
correlates `rewind_files` with the exact user UUID. Typed dry-run wire fields are
also declared by the official SDK distribution inspected in the prior native
contract research. The [CLI reference](https://code.claude.com/docs/en/cli-reference)
documents fresh-session forking; no provider operation-key deduplication is inferred.

Codex's [app-server docs](https://developers.openai.com/codex/app-server) and
pinned [fork schema](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkParams.ts)
provide a completed-turn inclusive fork. The helper validates exact source,
completed cut, fresh returned thread and fork origin. The session-tree root may
remain the old root; it is not the new owned thread ID. Any retained native goal
refuses fork because autonomous continuation is not scheduler-bound. The source
must clear that goal explicitly first. Missing/unsupported goal or history reads
refuse rather than guess. Native history revert does not restore local files;
this implementation therefore reports Codex file rewind unsupported. No native
file-only RPC was established by the inspected primary contracts.

Compatibility and lost-native-ACK lookup remain external limits. The code does
not claim arbitrary historical/session migration, different-root copies,
whole-workflow restore or universal harness parity. Unproven external effects
remain unknown; no source Run is replayed or declared completed.

## Deferred regression source

`tests/agents/{codex-transcript-fork,claude-file-history,native-history-authority,native-history-projection}.test.mjs`
contains boundary, exact-ID, wrong-session, goal refusal, unknown-result,
reservation/key and closed-projection cases. They were written, not executed.
Source/diff review only: no tests/checks/builds/typechecks, Node/native/SDK/provider
or browser execution, dependency installation, push, merge or deployment.

## Additive UI REST contract

All REST DTOs are exported from `@ponderosa/core` in `native-history.ts`:
`HistoryBoundary`, `HistoryReceipt`, `NativeHistoryResult`, `NativeRewindFileFact`,
`NativeRewindAncestor`, `NativeHistoryInventory`, `NativeHistoryOperationRequest`,
`NativeHistoryOperationResponse`, cancel request/response, tracking request/response,
and error. Physical ancestors retain the exact tuple order documented by the type.
Native optional fields remain optional; missing files/counts do not prove restoration.

GET/POST `/api/agents/:id/native-history/tracking` reads/sets a Claude-only preference.
POST body is exactly `{ "enabled": true }` (or false). Default is disabled.
The persisted preference applies only to the **next native session opening**; saving
it does not restart, mutate, or retroactively instrument the retained session.
The optional `currentSession` is an observed retained catalog boundary and actual
startup tracking flag after a supported native init; absence means unconfirmed, never disabled.
This confirms session configuration, not that any particular file has a backup. The preference alone is
not confirmation of current tracking. Existing backups/catalog entries are not
created by enabling or erased by disabling. No new session is automatically opened.

Inventory GET now returns `eligibleTargets: [{agentId}]` using the same canonical
emptiness/ownership checks as fork POST, including existing history reservations.
Labels come from the Agent directory. Listing is advisory and creates nothing;
POST revalidates. An empty list means no eligible existing target. Do not manufacture
Agents, infer eligibility from directory metadata, or infer operation success from
HTTP failure. Exact original key readback and unknown holds remain unchanged.

## Current integration scope

Backend successor `3d97ba4d2381c56b7395ec0d047c8753ddc4033d` and Settings UI
`f46b61d3511b9e502799c679d086885ddc694a3d` are composed in source with current
Claude task lifetime/stop, replay framing, approvals and runtime controls retained.
The UI preserves complete original commands before one POST, exact-key readback,
60-second physical previews, separate restore/delete versus fork consent and
unstarted-only cancellation. Current permission is not a catalog decision; server
policy gates remain authoritative. No execution, native acknowledgement, rendered
acceptance or whole capability parity is established.
