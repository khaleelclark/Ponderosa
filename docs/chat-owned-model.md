# Chat-owned model migration

Status: experimental implementation now snapshots Chat context, resolves live
execution from that context, enforces Chat-scoped broadcast/artifact access,
and provides an unsaved first-Send composer and Chat instructions settings.
Legacy Project IDs/paths and APIs remain as storage/history compatibility;
this is not a physical database-table removal. Existing shared source folders
are preserved, not copied or sandboxed. Presets remain reusable configurations.
First-message attachments require sending the initial message before upload.

## Target

- A Chat is the durable ownership and collaboration boundary. It owns its Agents,
  hierarchy, instructions, runtime defaults, working-folder association, and
  Automations. Preserve the existing Agent/Request/Join/scheduler architecture.
- No Project selection, hidden default Project, or independently mutable Project
  container is required to create or use a Chat.
- Delegation, Team Chat, broadcasts, and inherited context stay inside the Chat.
  Cross-chat sharing and agent access are out of scope.
- Sidebar folders only organize. Moving or starring a Chat never changes access,
  instructions, filesystem association, or Agent ownership.
- All Messages remains an aggregate presentation with explicit per-Chat routing;
  it does not become shared agent memory.
- Fresh launch and the logo open Home. New Chat opens an unsaved composer; first successful Send establishes
  the Chat exactly once. Restore a returning session and honor direct links. Keep
  drafts on failure; retries cannot duplicate Chats, messages, Agents, or Runs.
- Chats/Agents/Automations spine clicks only switch the sidebar. All Messages is
  the existing direct feed shortcut. Preserve desktop collapse and mobile gestures.

## Migration rules

1. Preserve stable Chat, Agent, message, Request, Join, Automation, and artifact IDs.
   Historical canonical communication and audit records are not to be rewritten
   as newly authored events. Retain explicit legacy provenance where necessary.
2. Copy inherited instructions/defaults into each Chat's independent metadata.
   Preserve explicit Chat overrides and the current working-folder association.
   Never move/delete source repositories or infer filesystem ownership from a
   sidebar folder. Physical filesystem isolation is not an existing guarantee:
   provider processes run with the host user's authority.
3. Attribute agent outputs through their originating Agent and its owning Chat.
   Attribute human-authored documents through their canonical Communication;
   `local-operator` is not an Agent. Validate projected attribution against the
   canonical journal before writing migration state.
4. Treat shared presets and artifacts deliberately. Copy preset configurations
   where they were available, retaining original provenance. A visibility label
   from the former Project is not permission to share across all Chats. Do not
   silently invent ownership for ambiguous records.
5. Existing deleted-Agent tombstones remain historical evidence, not newly live
   Agents. Preserve historical request/audience identities even if no live owner
   remains. New work requires a live, valid Chat owner.
6. Database, canonical metadata, and managed-file transitions require a durable,
   resumable migration journal and rollback rehearsal. Drain runtime authority
   before cutover; do not rebuild authoritative SQLite coordination from JSONL.
7. Legacy URLs may resolve to migrated resources, but cannot recreate Project
   pages or a mutable Project domain.

## Required qualification

- Real-data copy: every Chat, live Agent, Automation, historical message, and
  artifact is accounted for; canonical hashes and source files preserved.
- Same-chat Agent creation, hierarchy/reparenting, delegation, Joins, handoffs,
  Team Chat, runtime continuation, and completion still work.
- Cross-chat communication, broadcast inheritance, artifact context, membership,
  and Automation targeting fail closed, including under stale client requests.
- New empty composer creates no saved records. First Send and retry are
  idempotent; failure retains the draft. Files and model selection still work.
- Chat deletion drains only that Chat's authority and never deletes source files
  or another Chat's resources. Crash/restart at each migration boundary recovers.
- File search, old links, All Messages, notifications, desktop/mobile navigation,
  and sidebar organization retain their existing functionality.

## Read-only preflight

Build `@ponderosa/agents`, then run:

```sh
node packages/agents/dist/chat-ownership-audit.js /path/to/copy/ponderosa.db
```

This opens an existing SQLite database read-only without AgentStore startup
reconciliation. It audits projected ownership and reports at most 20 example IDs
per finding. Exit 2 means unresolved ownership findings. No findings does **not**
certify canonical integrity, filesystem safety, or migration readiness.

Experimental snapshot checked on 2026-09-16 at base
`d3dacef03bd85b8c53b6f433c1528f2a1c7c5946`: 9 Projects, 18 Chats, 62 Agent records,
12,499 managed artifacts, 278 Requests, and 36 presets. The preflight found no
unresolved projected ownership after accounting for human-authored documents.
Offline full-state rehearsal preserves all 18 Chats, 62 Agent records, 278
Requests, 12,499 artifacts, and the hashes of all 102 canonical journals across
the migration and a second startup. Runtime services are not started in rehearsal.

## Mandatory promotion gate

**No dev or production promotion is authorized.** The operator must explicitly
request promotion separately; a passing technical gate is not authorization.

Live runtime selection now resolves the owning Chat before model/effort fallback,
capability discovery, workspace checks, and run preparation. Explicit settings
and active Run snapshots retain precedence. Historical receipt replay stays before
live Chat validation. A cleared Chat default falls back to workspace/provider
defaults, never back to an independently mutable legacy Project.

Before converting any legacy Chat metadata, startup validates the entire pending
batch and runs the ownership preflight. Unresolved findings stop conversion before
the first metadata write. Already committed Chat metadata is not overwritten on
restart. Explicit instructions and working directories are preserved. This guard
does not certify canonical history or substitute for release qualification.

Use the bundled Node 24 runtime and built candidate packages:

```sh
node packages/agents/tools/chat-ownership-qualification.mjs capture \
  /path/to/target-state /new/offline-snapshot TARGET_REVISION
node packages/agents/tools/chat-ownership-qualification.mjs verify \
  /new/offline-snapshot /new/rehearsal-output \
  /target-release/packages/agents/dist/index.js CANDIDATE_REVISION
node packages/agents/tools/chat-ownership-qualification.mjs gate \
  /new/rehearsal-output/qualification.json CANDIDATE_REVISION /new/offline-snapshot
```

Capture uses SQLite backup APIs and checks both database contents and file hashes
before/after. Concurrent changes reject the copy; never waive this check or silently
stop a live service. Verification starts AgentStore only on disposable clones, never
on the input or live target. It checks ownership, canonical/source-file preservation,
resource counts, authoritative coordination state, second-start idempotency, and a
full-snapshot restore under the target's old AgentStore. It never starts providers,
the scheduler, or network listeners. Qualification is tied to the exact candidate
revision and snapshot; any newer candidate or changed target requires rerunning it.

Rollback is a **complete pre-cutover state restore plus the old binary**, not a
binary-only downgrade after independent Chat settings have changed. At actual
cutover, obtain explicit authorization, drain runtime authority, capture a fresh
backup, and require the exact candidate/snapshot gate to pass before deployment.

### September 16 follow-up qualification

- Current live dev capture was rejected because canonical files changed during
  capture. Dev was neither drained nor restarted.
- A stable copy of `before-beta12-a8e3be8d` (September 15) passed snapshot integrity:
  220,708 files; 70 Projects, 85 Chats, 479 Agent records, 9,419 artifacts,
  494 Requests, and 280 presets.
- Qualification correctly **blocked before migration**: 229 artifacts originate
  from seven deleted Agents whose retained records have no Chat ID; no deletion
  tombstone supplies that ID. No owners were guessed and no historical records
  were rewritten. These require explicit, evidence-backed legacy provenance
  handling before this dataset is promotion-ready.
- Disposable-fixture tests cover migration, restart, rollback restoration, stale
  qualification rejection, and real process death before/after metadata commits.
  A successful fixture rehearsal does not waive the real-data blocker above.

### Explicit legacy-artifact recovery

The operator may opt into `verify ... --recover-deleted-agent-artifacts` on an
offline snapshot. This creates a **Recovered Files** Chat and archived **Legacy
Imports** custodian in each affected legacy namespace, using the baseline store's
tracked creation methods. No provider, scheduler, activation, or Run is started.
Only artifacts whose retained creator is deleted and has no Chat are eligible;
unknown creators and other ownership findings still block qualification.

Recovery appends `legacy_custody` records to the managed artifact journal. Original
creator IDs, artifact IDs, bytes, hashes, paths, descriptions, timestamps, and
audiences are unchanged. Custody supplies the Chat location, not fictional
authorship. Private audiences remain private, and ordinary UI labels recovered
files explicitly. The archived custodian cannot execute work.

Qualification verifies byte integrity through existing no-follow file access,
exact permitted metadata/journal additions, original history and runtime authority,
ownership, restart, and full original-snapshot rollback. Failed attempts remain
disposable evidence; retry into a new output directory. This optional recovery is
never performed by normal startup and never changes the input or live deployment.
Passing an old-backup rehearsal is not approval to migrate today's dev data.
