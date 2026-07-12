# Communication Infrastructure Cohort Cutover

Use this runbook per project/organization. Do not combine cohorts or skip a gate.
Record the release SHA, data snapshot, operator, timestamps, reconciliation output,
readiness output, and rollback duration in the change record.

## 1. Preconditions

- Final branch checks pass: `git diff --check`, `pnpm typecheck`, `pnpm test`.
- Architecture, security/privacy, SRE, and product/UX gates are approved.
- The previous good application SHA and its compatible data snapshot are retained.
- The service is single-writer; no other daemon uses `PONDEROSA_DATA_DIR`.
- Capture is `shadow`, reads are `shadow`, curated context is enabled as approved,
  and legacy routing is `reject` for current sessions.

Verify effective state:

```bash
curl -fsS http://127.0.0.1:8787/api/ready | jq .checks.communicationMigration
```

Stop if the service is not ready or the reported modes differ from the change plan.

## 2. Quiesced backup and restore proof

Follow the full-directory backup procedure in `deploy/README.md`. Restore it to a
clean directory and run a temporary daemon on a different port. On the restored
copy, rebuild projections, open representative Master/Collaboration/Direct views,
and require ready status. Record RPO/RTO and hashes of the backup artifact.

Never back up or restore SQLite alone.

## 3. Dry-run historical backfill

```bash
PROJECT_ID=replace-me
BASE=http://127.0.0.1:8787

curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/communication-backfill" \
  -H 'Content-Type: application/json' \
  --data '{"dryRun":true}' | tee communication-backfill-dry-run.json
```

Every blocked Collaboration record requires an explicit stable recipient mapping.
Do not infer an audience from display text. Prepare and review a payload such as:

```json
{
  "dryRun": false,
  "collaborationRecipientsByMessageId": {
    "historical-message-id": ["stable-agent-id"]
  }
}
```

Apply the reviewed payload. It is deterministic and safe to retry after a crash.
Re-run the dry run and require `candidates: 0`, `blocked: []`.

## 4. Reconciliation gate

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/communication-reconciliation" \
  | tee communication-reconciliation.json
```

Require HTTP 200, `ok: true`, and empty arrays for missing projections,
duplicates, orphans, classifications, projection metadata, unlinked legacy rows,
and DTO mismatches. HTTP 409 is a stop/rollback condition.

## 5. Authoritative-read cohort

Set and restart:

```text
PONDEROSA_COMMUNICATION_MODE=shadow
PONDEROSA_COMMUNICATION_READ_MODE=authoritative
PONDEROSA_LEGACY_ROUTING=reject
```

`communication=off` with authoritative reads is invalid and fails closed. After
restart, require `/api/ready` to report ready and parity `ok`. Exercise:

1. Manager broadcast and reply with attachment.
2. Explicit-recipient Collaboration, including busy-recipient queueing.
3. Direct Agent turn and response.
4. Delegation objective, declared outcome, and parent completion delivery.
5. Cancellation, compaction, lifecycle health, and restart recovery.
6. Knowledge promotion, fresh seed injection, and local-source non-disclosure.

Compare message IDs, event IDs, authors, reply/attachment snapshots, reactions,
ordering, and agent health against the shadow evidence. Monitor queue depth, retry
attempts, reconciliation, readiness, error rate, and manager polling load.

## 6. Immediate read rollback

If parity, availability, privacy, routing, or queue SLOs regress, set:

```text
PONDEROSA_COMMUNICATION_READ_MODE=shadow
```

Restart, require ready status, and repeat the representative reads. Do not delete
canonical events or projection revisions. Preserve a forensic copy and reconcile
forward after the fault is understood.

For an old-session routing rollback only, temporarily set
`PONDEROSA_LEGACY_ROUTING=accept`; scope it to the smallest cohort and record the
expiry. Never pair that rollback with organization expansion.

## 7. Expansion and retirement

Run two successful production-like cutover/rollback rehearsals before expanding.
Expand one organization-sized cohort at a time. Pause if any gate is conditional,
the review queue grows, or manager span exceeds policy.

After the approved clean observation window:

- verify no current UI/runtime emits the old `channel` wire or mention routing;
- verify legacy rollback mode was unused or every use was resolved;
- repeat backup/restore and DTO parity;
- remove compatibility parsing and legacy-only stores in a separate reviewed PR;
- retain canonical logs according to the approved retention/erasure policy.

The release owner—not an automated test—signs the final retirement gate.
