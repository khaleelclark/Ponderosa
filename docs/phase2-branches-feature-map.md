# Phase 2 Branches feature map

This is a bounded implementation plan against source commit
7f3d0b4b6e0bb4c5d699142e5b038a8ad545ad5b, not a completion claim.
The audited ui096 release manifest identifies that same Git commit. The shared
source checkout's master was aff35d74b and is not the audited target. The ui097
release identifies c581d406604d9cec7fee69cb5e118ce024285d95; integration must review
changes since the audited base before a candidate release. No compiled release
is edited by this batch.

## Existing architecture and finite dependencies

| Work | Existing implementation to extend | Finite next implementation and acceptance boundary |
| --- | --- | --- |
| #10 public engine | `apps/server/src/routes/branches.ts`, `packages/core/src/branches.ts`, BranchStore | Preserve public deploy/admit/read interfaces. Repeat the external HTTP-only Script app after integration; no private client hooks. |
| #16 catch-up | `branch-trigger-service.ts`, `packages/agents/src/branch-trigger-store.ts` | This batch fixes distinct due occurrences with bounded cursor-preserving catch-up. Existing store owns atomic admission and explicit overlap modes. Complete rendered reason and timing checks on the integrated candidate. |
| #25 provider billing mode | `packages/engines/src/auth.ts`, Adapter interfaces in core, `routes/engines.ts`, workspace preferences and settings | Add explicit human mode selection and secret input/exclusion; route both modes through the same adapters. Remove mode-specific subscription refusals only alongside that contract. Fake both CLI modes and state-preserving switch first, then authorized real credentials as a handoff. Never replace agent records to switch modes. Bible #25 supersedes the older subscription-only AGENTS invariant. No credentials or mode changes in this batch. |
| #30 combined memory | `local-memory-catalog.ts`, `local-memory.ts`, `routes/provider-dynamic-tool-handler.ts` | Keep one default search over both authorized scopes; clarify omitted-source semantics in tool metadata and run seeded handler trials plus first-use subjects. Coordinate catalog edits with runtime permission owner, who owns human-only permission enforcement/global write defaults. |
| #31 full streaming | `routes/streams.ts`, `useAgentStream.ts`, `useWorkspaceStream.ts`, `components/branches/ExecutionPanel.tsx`, `voice-reply-stream.ts`, `routes/voice-replies.ts` | Reuse native stream events and exact run/attempt identity across chat, Inbox, task/execution, Branch and output-app surfaces. ExecutionPanel currently renders completed attempt results; checkpoint SSE is not token streaming. Add per-attempt deltas and reconnect reconciliation before reusing the view. Controlled stream tests first; audio mean <1s/max <=2s and clean device recordings remain separate acceptance work. |
| #32 native parity | `packages/core/src/branches.ts`, BranchStore graph/checkpoint tables, routes and engine | Freeze graphs/state/checkpoints+rewind/HITL/streaming/tools/memory/subgraphs/multi-agent checklist. Graph routing, gates, nested branch calls and checkpoints already exist. Add arbitrary checkpoint selection/rewind with durable execution lineage; prove matching representative apps on pinned external framework versions. Do not claim structured output/middleware/ecosystem parity from Script extensibility. |
| Output-agent apps | Branch bindings + persistent branch chats/agents routes, shared Agent chat/attachment/voice primitives | Add output designation and stable URL DTO/store/routes first; then shared output-chat shell and schedule/model settings writing the existing workflow. Reuse attachment and voice authority, not a second message store. Gates: URL roundtrip, direct routing, attachments, voice, call, schedule/model propagation, all-surface streaming, blind panel. |
| Assistant | Same output app plus workspace preferences, Branch installation/deployment, notification settings | After output designation, add singleton Ponderosa-speaker constraint in durable storage; default workflow bootstrap and idempotent fresh-install check. Default schedule is 10 minutes. Deletion/removal disables; explicit re-enable creates only if absent. Import collision preview disables imported designation with a dialog. Test model/prompt edits preserve designation, concurrent enable/import, permission-respecting cross-project create/start and notification policy. |
| Inbox rename | `ProjectNavigation.tsx`, `App.tsx`, `AllChatView.tsx`, `allChatRouting.ts`, route kind `allChat`, `/messages`, API/hooks/DTOs and docs | Rename UI and internal symbols coherently in a separate batch; keep canonical communication scopes and routing intact. Coordinate shared navigation/composer files with UI lead. Search case-insensitively for the old phrase, then run navigation and communication regressions. |

Dependency order: public durable output designation → shared output shell and
streaming → Assistant bootstrap/settings/actions. Inbox rename and provider modes
are independent; memory metadata depends only on coordination with runtime owner.
Checkpoint rewind is a separate graph-store change. No new framework, websocket,
provider inference, external service, or credential is necessary for the first
controlled regression checks.

## Remaining verification

No whole-commandment True verdict follows from this patch. #28 needs aggregation
across all 32 Branches checks. Source mapping does not implement any new feature.
Human-only handoff is limited to unavailable account/device actions: authorized
real mode-switch trials and real speech/provider timing if controlled/emulated
checks cannot supply them. Agent/device simulation and blind judges remain work
for the organization; they are not inherently human-only blockers.
