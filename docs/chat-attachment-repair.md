# Repair a retained Chat attachment from a backup

This procedure restores only verified attachment bytes and a Chat-owned retention mapping. It does not restore a database, edit a message, revive an Agent, or recover files belonging only to a deleted Chat. It is an explicitly authorized maintenance operation, not an automatic migration.

## Preconditions

1. Obtain approval for the specific Chat/message/attachment and selected backup. Keep the original backup unchanged.
2. Stop the application that owns the target data directory and confirm it released its exclusive store lock. Do not run this CLI against a live service. Use the correct system or user service for that installation, not a guessed unit name.
3. Take a current offline backup using the installation's bundled `data-directory.mjs backup` command. Do not replace current data with the older backup.
4. Identify the current canonical Project ID, Chat ID, Communication event ID, and attachment ID. The Chat and its canonical projection must still exist. The attachment must have a recorded owner, size, and SHA-256.
5. Supply the root of an extracted, trusted backup preserving `projects/<project>/agents/<owner>/attachments/<attachment>.bin` and any recorded `<attachment>.preview.png`. Do not supply a source repository, arbitrary uploaded file, or the whole backup archive as this root.

Use the CLI bundled with the reviewed application artifact. In a verified source checkout, the equivalent command is:

```sh
node packages/agents/tools/data-directory.mjs attachment-repair \
  --data-dir /absolute/current-data \
  --project-id PROJECT_UUID \
  --chat-id CHAT_UUID \
  --event-id CANONICAL_EVENT_ID \
  --attachment-id ATTACHMENT_UUID \
  --backup /absolute/extracted-backup-root \
  --reason 'Approved repair of the attachment missing after Agent deletion'
```

Without `--apply`, the command verifies target eligibility and original bytes and emits a `preview` JSON record. It publishes no repair copy or mapping. Opening the offline store can still perform normal startup reconciliation; this is not a forensic read-only database utility. A missing/unsafe source, wrong size/hash, absent Chat projection, or wrong Chat scope is rejected.

## Apply and verify

Review the preview IDs, size, hash, and `alreadyRetained` value. Repeat the exact approved command with `--apply`. Success emits `status: "retained"`. The retention manifest records the original identity, hash, publication time, backup source, and operator-provided reason. Source and destination storage identities are checked during publication. Existing matching copies are verified rather than duplicated; conflicting or damaged retained copies fail closed.

Then restart the application and verify:

- The same original message and attachment ID remain in the same Chat.
- Preview, where supported, and download return the expected bytes.
- No deleted Agent reappears and no unrelated Chat gains access.
- The application starts without falsely reporting this already-completed message as uncommitted.

Keep the preview/apply output and repair reason with the maintenance record. If the command fails, preserve its error and the current data and backup; do not overwrite canonical records or force deletion cleanup. If a verified retained copy is damaged, investigate separately rather than deleting the mapping to bypass the check.

## Qualification in this PR

Disposable tests exercise preview, apply, repeat apply, wrong hash, wrong Chat scope, unavailable historical files, unchanged canonical message identity, and no Agent revival. No historical dev attachment has been repaired as part of this implementation. Native Windows execution and physical-phone preview remain separate qualification tasks.
