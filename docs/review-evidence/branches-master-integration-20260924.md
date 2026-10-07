# Branches integration and upgrade qualification (2026-09-24)

This pass merges `origin/master` at `913d4d9be652d85829adac520608762d444b3ef6` into the Branches dataflow head `7b5f2a0bfd9dc45e64a9fc2310b887295f0b84ee`. It adds no new workflow control or scheduler.

## Root cause and correction

Opening a sealed copy of the existing Dev data directory with the pre-integration Branches head reproduced 75 → 73 projected Projects. The missing Project IDs were `0895c683-0efe-4258-af6a-5d726d7f35fe` and `f68f5f22-114a-4389-9640-84937b8f60d9`; their four Chats, 43 Agents, 6,589 execution artifacts, and 9,239 managed artifact projections also became unreachable. Canonical Project and Agent files were unchanged. Reprojection rejected legacy artifact custody because it required the custodian Agent to be live **now**, although the custodian was live when the artifact was created and was deleted later. Master’s historical-custody validation checks that event-time identity and the deletion record; the integration retains that correction.

A separate read-path issue surfaced in independent review. Deletion clears an Agent’s live Chat pointer, but 308 historical execution artifacts and 308 managed projections in the Dev fixture still belong to those Agents. Product-scoped artifact listing and direct reads now use recorded Chat/deletion ownership, not only the current pointer. A small additive migration classifies older deletion receipts as Dev only when the Project has recorded Dev Chats and no Branch-owned Chat/resource history. Ambiguous or mixed history stays unknown. Three Dev Projects with no remaining Chats are also still reachable through their Dev Chat deletion receipts.

## Exact upgrade result

The untouched Dev snapshot, a sealed duplicate, the old-stack reproduction clone, the integrated upgrade clone, and exact-identity reports are retained under `/home/phoenix/.local/state/branches-integration-*20260924*` and `/home/phoenix/.local/state/branches-integration-final-*`. The sealed baseline database SHA-256 is `e0ef91ed0e4cfa6abaa45ffc7c4e8af3ca353eb332d078158a07ecb00fa224e7`.

| Canonical or projected entity | Before | After integrated upgrade | Lost/new/original-field changes |
| --- | ---: | ---: | ---: |
| Projects | 75 | 75 | 0 / 0 / 0 |
| Chats | 87 | 87 | 0 / 0 / 0 |
| Agents | 527 | 527 | 0 / 0 / 0 |
| Requests | 629 | 629 | 0 / 0 / 0 |
| Triggers | 2 | 2 | 0 / 0 / 0 |
| Trigger occurrences | 54 | 54 | 0 / 0 / 0 |
| Execution artifacts | 11,993 | 11,993 | 0 / 0 / 0 |
| Managed artifact projections | 14,667 | 14,667 | 0 / 0 / 0 |

The Dev snapshot predates Branches tables and has zero Branch definitions/executions. Added nullable Branch ownership and speed columns are expected schema changes, not changes to existing fields. First upgrade and subsequent boots had no recovery issues; second and third boots kept exact identities and original fields. The 308 deleted-Agent artifacts regained Dev read scope and are absent from Branches reads.

An existing Branch fixture with 13 definitions, 1,157 executions, 72 child calls, 9,082 Map items, 10,190 sealed results, 90,681 checkpoints, and 5 result bundles reopened with all Branch rows and parent/child relationships unchanged. A controlled prior-schema fixture retained completed, failed, and waiting-Decision executions with their terminal/waiting states. No old execution was silently reinterpreted.

## Migration interruption and rollback

The schema extensions and version markers commit in SQLite transactions. In one isolated clone, the process was killed after staging `0013_branches.sql` but before commit; reopening rolled that transaction back and completed the upgrade. In another, the first migration and marker committed, then the process stopped before the next phase; reopening resumed the remaining migrations. Both retained all original fixture IDs and fields without manual SQLite repair.

Rollback means restoring a pre-upgrade **whole data-directory backup** after stopping the daemon. It is not a reverse migration: some migrations rebuild tables, and opening an upgraded database with the older Branches head is unsafe on this realistic Dev fixture. Preserve database, canonical Project/Agent logs, workspace event log, artifacts, and layout metadata together. Do not copy only `ponderosa.db` or run the old binary against upgraded state.

## Focused runtime smoke

An isolated full daemon used a subscription-backed Codex Agent to complete a Branch Request with a two-item list. For Each sealed two items; one Script item failed once and retried; Join kept item identity and order; a Script chose a declared Route; the run waited at a human Decision. The daemon shut down and restarted cleanly with the same waiting gate and sealed results. After approval, a child Branch Call and final Script completed with `done:child:Proceed`. The isolated daemon was then stopped. No live Dev directory or earlier preview process was used.

## Review and PR order

An independent read-only review found the deleted-Agent artifact access defect above and confirmed that live staged/retiring Branch resources must remain outside artifact reads. Both were fixed and re-reviewed; no further concrete blocker was reported. Review foundational fixes in PR #570, then dataflow runtime in PR #571, then this integration PR. Keep the PRs separate until their exact-head checks pass; merge in that order. This integration branch contains a merge from current master so master’s corrected ownership and artifact custody stay visible in the third review layer.
