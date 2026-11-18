# Whole-group unadmitted destination retirement

Runtime successor to integration bd5c5f9d8c8f8ebea388451696c6095924dc41d5.
This is a host-only canonical primitive, not provider authority or a lifecycle UI route.

CoordinationV3Store exports:

- `reviewCoordinationDestinationGroupReconciliation(id, operatorId, authority)` returns `CoordinationDestinationGroupReconciliationReview`.
- `retireCoordinationDestinationGroup(input, authority, now?)` returns `CoordinationDestinationGroupReconciliationReceipt`. Input is the existing `{admissionId, commandKey, operatorId, expectedReviewHash, releaseSourcePins}`.
- `readCoordinationDestinationGroupRetirement(id)` returns the verified immutable receipt or null.

Review/retire require the same owner SQLite transaction. Retire uses a nested savepoint, so a caller catching a failure cannot accidentally commit partial slot/member removal. Singular APIs continue to refuse group review/retire/readback; group APIs refuse singular evidence. An already admitted graph or admission receipt always refuses retirement.

`CoordinationDestinationGroupReconciliationAuthority` is exported by agents and has distinct whole-group callbacks:

```
inspectGroup({operatorId, reservation, stage, groupChats}) -> {revision, references}
requireGroupApproval(input, review) -> void
```

Both must be synchronous and throw on refusal. `reservation.resources` is the complete 2..32 resource inventory. `groupChats` is the exact ordered canonical slot inventory, with fields `admission_id`, `source_chat_id`, `source_execution_id`, `conversation_id`, `stage_json`. A slot stage is the original canonical JSON string or null. This includes partial incremental imports even when the admission's assembled `stage` is null. Whole-stage imports may have all slot stages null; incremental staging assembles only after every slot exists. Repeated owner executions are allowed, but source/fresh Chats and resource Steps are distinct and destination Project is shared.

The host observer must independently establish current/deleted-owner operator authority, completed deletion receipts for EVERY destination Chat and staged member (plus any additional tombstone identities), actual observed provider/native exit and live quiescence, resolved external effects/imports, and exhaustive current Branch/package/import/restore/capture/owner references over EVERY resource. Source drain and terminal Run status are not destination exit proof. Exclude only the exact whole admission's own pins. Bind the returned revision to all evidence. This primitive does not accept operator drain testimony as a replacement for host observation.

Canonical review checks exact reservation/snapshot bytes and hash, row ownership, whole slot identity inventory, imported member maps and rolled-back import rows per Chat, no surviving destination Chat/membership/live mapped Agent, and no active/unknown mapped Run or activation. Soft-deleted audit identities remain retained. Partial slots require actual rollback receipts for their own import operations. An empty reservation still needs host observation proving no unrecorded import/effect. Malformed/incomplete/aliased inventories refuse.

The review hash binds every original admission row, snapshot, stage, slot, member, import operation and host evidence revision/reference set. Approval must be the explicit durable HUMAN decision for this exact whole-group hash and pin disposition. Runtime re-runs the complete review after approval; any changed slot, policy/authority revision, reference, outcome or identity refuses. No resource is independently retired in a loop.

Retire writes ONE existing immutable retirement row containing the original admission/snapshot/stage, every slot stage, members, import operation rows and review. Receipt adds `resources`, `groupChats` and `evidenceSha256`. Readback verifies canonical retained bytes, evidence hash, original reservation hash, exact inventories, command and review hash without needing surviving owners/import rows. Exact command replay reads this receipt without recomposing or releasing anything again; changed input conflicts. Readback is private audit evidence, never a disclosure grant.

`releaseSourcePins:true` requires zero external references, then atomically removes ALL group slot RESTRICT pins, member rows and unadmitted admission. Any failure rolls back the tombstone and all removals. `false` permanently retains every pin; no later upgrade is implemented. Original snapshot/Branch/package references remain independently owned and are never deleted here. No admitted reclamation, package deletion, historical replay, timeout, import retry, process termination or new migration is introduced.

All destination Chats remain tombstoned even after group slot deletion: admission reuse, runtime staging/scope/intake/activation helpers, scheduler lease SQL and product ownership SQL inspect the receipt's entire `resources[*].destination.conversationId` inventory, as well as retained mapped Agent IDs. Existing singular tombstones remain effective.

`tests/branches/destination-group-reconciliation.test.mjs` contains THREE deferred source fixtures: stale/approval/reference refusal plus caught partial-delete rollback and exhaustive immutable replay; non-first identity/runtime/import refusal and permanent preserve-only pins; partial slot retention, admitted refusal and corrupt readback. They use real destination schemas with synthetic custody/host observer evidence, not actual provider exit or Branch owner-tree qualification. No test/check/build/type/Node/native/browser/runner or migration execution was performed. Reliability owns host observer/journals/routes/SDK composition and its qualification separately.
