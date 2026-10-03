# Project removal: inventory/design checkpoint

Status: **preparation only; domain removal and upgrade are not implemented**.
Sole writer: Codex, `feat/chat-domain-ownership-20261003`, dedicated
`chat-domain-ownership` worktree. Stack base: PR #612 at
`61d0a66f22c7b175e478e0ddcde91e708bb73c0d`. Revalidated master:
`e2a2244e20e4a34584ba7537f5b07256da61e14a`.

The supplied specification requests a physical ownership migration. Renaming
fields or hiding Project UI is not sufficient. This checkpoint deliberately
does not enable a half-migrated model, change existing APIs/layout/schema,
rebuild runtime authority, or rewrite history.

## Existing mechanisms and gaps

`chat-ownership-audit.ts` already opens SQLite read-only without AgentStore.
Its existing findings remain unchanged. Optional `--inventory` now enumerates
every retained scope's actual child Chat IDs, including zero and multiple
children, and every table's row count, primary key and ownership columns.
It fingerprints schema definitions. Single-child cardinality is not a resource
ownership proof; every report explicitly remains `inventory_only`.
Inventory mode rejects WAL-mode databases and any SQLite sidecars before opening
SQLite. Supply a verified coherent offline rollback-mode export, not a raw live
database. This preserves committed WAL data rather than silently ignoring it.
The pre-existing default audit/runtime path is unchanged; its read-only SQLite
open is not a guarantee that WAL/SHM sidecar files cannot be created.

`chat-ownership-qualification.mjs` already captures coherent database/file
manifests, rehearses on disposable clones, rejects changed inputs, verifies
canonical preservation and authoritative rows, repeats startup, and restores
the complete original snapshot under the old AgentStore. Its current transform
only snapshots Chat settings. It must be extended, not replaced, for physical
schema/layout cutover. Its existing deleted-Agent recovery opt-in creates an
archived Agent; the new target must instead support non-executable historical
custody without inventing a live owner. Existing optional recovery is not
silently invoked or changed by this checkpoint.

## Dependency/caller map

| Boundary | Existing callers/authority | Required target |
| --- | --- | --- |
| First Send | `NewChatComposer.tsx`, `api/real.ts`, `routes/projects.ts`, `store-workspace-catalog-authority.ts` | One idempotent Chat creation; stable Chat ID owns initial Agent/message/Activation. |
| Core context | `dto/projects.ts`, `dto/conversations.ts`, `store-types.ts`, `getChatContext`, run preparation | Direct Chat DTO/context; no Project-shaped adapter or backing ID. |
| Authored history | `paths.ts`, communication authorities/projectors, revision/placement journals, context/history compilation | Chat-native writes; original shared journal stored once as immutable evidence with verified placement indexes. |
| Coordination | `coordination-v3-*`, scheduler, required replies, activation outbox, exact prompt injections | Transform SQL ownership transactionally; preserve IDs, leases/fences, hashes, receipts and terminal authority. |
| Runtime/processes | `provider-process-authority.ts`, runtime authority, accepted-session contracts, continuation/rollover | Chat attribution, exact drain, incompatible-session reseed; no migration-created Run. |
| Files/attachments | `paths.ts`, managed-artifact files, `asset-authority.ts`, asset store, file/import routes | Chat-root access with existing descriptor/no-follow/stable-byte boundaries; retain IDs/bytes/audiences/source paths. |
| Browser | `browser-profile-authority.ts`, session manager, broker protocol/checkpoints, Run tools | Exact Chat/Agent/Run owners; preserve singleton workspace saved browser and explicit borrowing grants. |
| Automations | trigger definitions/occurrences, source managers, trigger routes, activation payloads | One validated owning Chat; preserve occurrence/activation identity and untrusted-payload separation. |
| Deletion | store deletion receipts/tombstones, server drain/cleanup, asset/browser cleanup | Chat-only exact drain and retained retry failures; siblings, shared browser, source folders and working copies survive. |
| Client/cache | route registry/parser, API clients, query keys, SSE, drafts, preferences, push, extension/native host/launcher | One Chat API family, scope-versioned caches/cursors, clear stale-client mutation rejection. |
| Current guides/tools | AGENTS, system/Chat/communication/browser docs, deploy/backup/release tools | Update only when implementation changes; keep historical evidence exact and label remaining exceptions. |

This summary is not a finite caller enumeration. Generate the complete tracked
file/line inventory with the tool below. Every match is unclassified until
caller tracing establishes active, historical or generic usage. `projection`
is not matched merely because it resembles `project`.

## Route/DTO map to implement

| Old contract | Proposed Chat contract |
| --- | --- |
| Project + nested conversation creation | `POST /api/chats`, stable existing Chat identity; one first-Send receipt. |
| `/api/projects/:scopeId` settings/list/recency | `/api/chats/:chatId` settings/list/recency. |
| Project organization/Agents/presets | `/api/chats/:chatId/...`; validate the Agent's actual owner. |
| Project files/artifacts/imports | `/api/chats/:chatId/...`; opaque IDs and existing exact-byte checks. |
| Project browsers/profiles/Automations | Chat-owned routes; existing workspace saved-browser endpoints remain global. |
| Project event/notification/directory/cache keys | Chat owner fields and versioned scope contracts. |
| `/projects/:scopeId/chats/:chatId` or explicit Agent/resource link | Bounded old-link lookup through verified mapping; no mutation forwarding. |
| Bare old scope with multiple Chats | Neutral selection/recovery; never select a Chat or confer authority. |

Endpoint names above are a design target, not implemented availability. Existing
stable Agent/resource endpoints should be retained where ownership is derived
server-side. Old mutation endpoints must reject before side effects.

## Schema and layout map

Existing main schema: verified `0000_current_schema.sql` baseline plus ordered
extensions through `0022_provider_scope_authority.sql` and TypeScript migrations;
layout marker `1`. Never rewrite those deployed files or their markers. The
candidate must add an explicit verified Chat-native baseline/versioned offline
reader and reject unknown/damaged layouts. No new version is accepted yet.

| Existing location/authority | Target/disposition |
| --- | --- |
| `projects/<scope>/project.json`, Project table/settings | Remove active entity after independent Chat settings and dependencies are verified. |
| `projects/<scope>/conversations/<chat>/conversation.json` | `chats/<chat>/chat.json`, existing stable Chat ID. |
| `projects/<scope>/agents/<agent>/...` | `chats/<owner-chat>/agents/<agent>/...`; preserve Agent IDs and exact event bytes. |
| Scope-level Communication/revisions/placements/organization journals | New Chat-native journals; original bytes once in immutable evidence with mapping/index references. |
| Scope managed artifact/content and attachment paths | Chat-owned managed paths after total verified attribution; IDs/hashes/audiences preserved. |
| Main SQL `project_id` plus related scope keys/indexes/triggers | Chat ownership derived per row/resource, not a blanket scope-ID replacement. |
| `asset-authority.sqlite` | Separately staged/verified authority migration; quotas, receipts, drafts and pending cleanup preserved. |
| `browser-profile-authority.sqlite`, broker ownership checkpoints | Explicit Chat ownership or existing workspace saved-browser owner; ambiguous profile sharing blocks transform. |
| Profile directories, working copies, user source folders | Preserve identities and bytes; source/working-copy paths are not relocated or deleted. |
| Global preferences, host secrets, provider usage/status, workspace journals | Remain genuinely workspace-owned; no hidden Chat container. |
| Original snapshot and old binary | Retain for full-state pre-write rollback; no automatic lossless rollback after new writes. |

The main-db inventory does **not** inspect companion databases or profile
bytes. They are mandatory before a complete ownership map or transform.

## Cutover design and exceptions

Extend the existing qualification command with a durable operation journal:
preflight -> file staging -> database staging -> verification -> commit marker
-> cleanup. No mixed layout may serve or lease work. Every phase must retain
source/candidate identities, checksums/counts, explicit ownership decisions,
failure/recovery state and idempotent resume. The independent data-directory
lease plus offline staging guards this transition. Actual drain/cutover requires
separate authorization; do not use a promise race or guessed process cleanup.

Allowed final exception *classes*, not an approved per-file exception list:
immutable authored/audit/provenance records, immutable deployed-schema upgrade
readers and their fixtures, checksummed original journals/backups, bounded
old-link resolution, generic external metadata/user code. Active CRUD, mutable
legacy settings/runtime ownership, new Project-shaped records and broad normal
execution compatibility are not exceptions. A finite per-file list is a later
removal gate; this checkpoint cannot certify zero active references.

## Reproducible inventory

```sh
node packages/agents/tools/project-domain-inventory.mjs /path/to/candidate
node packages/agents/dist/chat-ownership-audit.js /approved/offline/ponderosa.db --inventory
```

Keep operator inventory output outside Git. The first tool reports tracked
repository text/filenames and does not inspect generated/package outputs. The
second opens only the supplied offline rollback-mode main database read-only. Neither starts
AgentStore, probes providers, migrates files/SQL, or approves release.

## Next required input

Identify an existing coherent offline snapshot and its source revision, then
inventory all companion stores and resolve each shared/unattributed resource
against canonical evidence. No snapshot was supplied with this request. Live
state capture/drain/migration is not authorized. In particular, the documented
September deleted-Agent ambiguity is a required regression, not today's verified
state. The full implementation and acceptance gates remain pending.
