# Multiple-package group capture abandonment

Source implementation only; the fixtures are deferred and do not establish native/provider or Branch consumer qualification.

The operator can abandon one **unsealed issued-group capture** with 2–32 exact generation-zero resource sources, including a completely uncaptured group or a partially captured group. A fully retained/sealed group stays held for separate historical checkpoint retirement. This command does not retire a destination, delete source Chats/Agents, reclaim history or package bytes, admit historical continuations, grant capability/disclosure access, or replay unknown work.

## Operator contract

`GET /api/lifecycle/checkpoint-capture-groups?limit=50&cursor=...` returns `{items,revision,nextCursor?}`. Each item contains the original `executionId`, raw persisted `captureKey`, full `sources`, `capturedCheckpointIds`, `sourceOwner`, state and evidence digest. Follow the cursor until absent; a changed inventory requires an explicit restart after HTTP 409. The existing 4096-record/16-MiB inventory and 1–100 page bounds apply. Discovery is independent of destination review/deletion, and reports original current or retained owner identity rather than manufacturing an ID from package metadata.

`POST /api/lifecycle/checkpoint-capture-groups/abandonment-review` accepts exactly `{executionId,captureKey}`. It returns the exact complete package source/file inventory, capture and Branch revisions, all external references, drain/effect blockers and `reviewSha256`. A review is not authority to mutate. The capture key is the persisted `issued-group-capture:<hash>` key supplied by discovery, never a guessed plaintext command.

`POST /api/lifecycle/checkpoint-capture-groups/abandon` accepts exactly `{executionId,captureKey,commandKey,reviewSha256,preserveEvidence:true}`. A fresh deliberate operator choice is required. It returns one group receipt containing every package reconciliation receipt and one immutable Branch disposition. `BranchesClient.lifecycleGroupCaptures`, `groupCaptureAbandonmentReview`, and `abandonGroupCapture` implement these calls without automatic retries. After a lost response, retain the complete original input and explicitly submit it unchanged for evidence-verified recovery. Different command/review/disposition input conflicts.

The operator routes inherit the existing local origin/capability audit boundary and effect-settlement guard. They are not Agent tools. They expose no package payload, Request body, private capture snapshot, or new authority to access a deleted owner.

## Commit and failure contract

The canonical Branch owner validates the entire raw issued-group intent, sources, partial receipt map, exact live resource/member closure, drain/native/effect evidence and every external custody reference in one owner transaction. Only this exact group's own capture pin is excluded. Unknown or foreign references hold the whole group. The host reuses the canonical owner hook rather than adding a Runtime retirement authorizer.

Before any package moves, one private fsynced immutable prepare journal archives the original command row and all package source, file-name, hash, byte-length and review evidence. Actual captured receipts must match the retained source membership and original payload length/digest. A published package whose SQL member seal failed is still checked against that exact original source. Uncaptured resources receive empty or partial evidence inventories and their own permanent package identity tombstones; no later capture may fill an abandoned slot.

The host calls **one whole-group Branch abandonment hook**. Within its single callback it preserves each package through the existing package reconciliation protocol, writes all package proofs durably, and returns one proof inventory to the canonical owner. There is no loop of singular Branch abandonment commands. Every payload/metadata byte is moved to retained evidence, never deleted. A package tombstone fences its old capture identity before files move.

All SQL cleanup-pin/disposition changes and the one `checkpoint_group_abandonment` host commit share the same outer owner transaction. If package two fails after package one is archived, or filesystem work succeeds and SQL fails, **all group SQL cleanup pins remain held**. Partial filesystem progress is recovery evidence, never permission to release a subset. The unchanged command can resume package moves using the immutable original inventories. Each recovered package verifies every original hash and byte length; missing, additional, duplicate or changed bytes refuse. Final host replay checks the complete retained package proof inventory and immutable result even after the live owner is removed. No unknown outcome is inferred as success.

## Remaining bounds

This slice is issued-group capture abandonment only. Retained groups, historical/disk reclamation, external writers that do not participate in the source boundary, unknown schemas/outcomes and unrelated destination retirement remain held under their own protocols. The existing private journal's 4-MiB bound can refuse a group before any package publication. Package size and 128-file per-custody limits remain unchanged. Source fixtures use injected owner/runtime ports; real canonical Branch boundary fixtures and consumer/native integration must be separately qualified.
