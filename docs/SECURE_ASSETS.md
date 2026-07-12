# Secure thread assets

Ponderosa assets are owned by one project/thread and have two durable states:
`staged` and `associated`. Uploading creates an atomic staged record. Sending a
message writes the canonical message event with the associated asset snapshot,
then advances asset metadata. Startup and hourly reconciliation repairs a crash
between those operations and expires staged records after 24 hours. Associated
assets are retained until their owning thread is deleted and are never removed by
the orphan collector.

There is deliberately no project asset library, cross-thread reuse, or asset ID
binding based on client-supplied metadata. Every stage, preview, download, delete,
and message-binding request resolves the owning thread and project again. Missing,
foreign, expired, corrupt, and deleted objects return the same `404` shape.

## Content boundary

- PNG, JPEG, and WebP inputs must have a strict, non-trailing container, decode as
  exactly one image under a 25-megapixel limit, and are re-encoded to a PNG preview
  by `sharp`. The app origin serves only that derivative inline.
- GIF and SVG are rejected. Animation and multi-page inputs are rejected.
- PDF, UTF-8 text, JSON, and ZIP are typed from bytes and are download-only.
  General downloads use `application/octet-stream`, `nosniff`, RFC 5987 filename
  disposition, `private, no-store`, and no range support.
- The original is SHA-256 checked before download or runtime use. Files and metadata
  use server-derived UUID names and mode `0600`; metadata filenames are validated
  against the ID rather than trusted. Every file operation is confined through an
  opened `O_DIRECTORY|O_NOFOLLOW` descriptor after realpath and ancestor checks.
- Display filenames are NFKC-normalized, byte-bounded, stripped of path/control/bidi
  characters, and never included in the agent prompt. Prompts identify an asset by
  server ID, validated media type, size, and server-generated local path only.

## Limits and audit

The server enforces 8 MiB per file/request, four assets and 24 MiB per message, 64 MiB staged
or associated storage per thread, two simultaneous uploads per thread, and twenty
uploads per thread per minute. Audit JSONL records state transitions using IDs,
ownership, type, size, and timestamps; it never records host paths, bearer tokens,
file contents, or filenames. SQLite `BEGIN IMMEDIATE` transactions serialize unique
in-flight reservations, committed asset-byte rows, and the one-minute rate window
across processes; releases are conditional on the exact reservation ID. Aggregate
quota combines committed and reserved bytes in the same transaction. Startup and
pre-admission reconciliation imports restored raw assets and fails closed if an
existing committed row disagrees with disk.
Active reservation identity prevents recovery from importing a write that is still
settling. Durable deletion tombstones are written before unlinking and retained so
a stale filesystem scan cannot resurrect a deleted asset ID.
Expired crashed reservations are reclaimed without giving an old process authority
over a successor. `audit.jsonl` remains canonical append-only evidence: a torn
final record is repaired before append, while non-tail corruption fails visibly.
SQLite imports and deduplicates that history and acts only as a serialized outbox,
so rebuilding the DB cannot erase or duplicate restored evidence. New events carry
UUID `event_id` values; legacy rows receive deterministic internal identities
without being rewritten. Audit repair and append use one `O_NOFOLLOW` descriptor
opened through the attachments-directory descriptor; regular-file ownership,
link-count, and mode are validated before any truncation. The reconciler
expires aged raw/temp orphans without deleting associated assets.

The product remains single-operator bearer-authenticated. These controls provide
object scoping; they are not a claim of user-level ACLs or multi-tenant isolation.

## Backup, restore, and deletion

Back up each thread directory together with its canonical `events.jsonl`; the
`attachments` directory contains originals, derivatives, metadata, and the audit
log. The asset-authority SQLite database contains only rebuildable in-flight/rate
control state and is not the message/association source of truth. Restore the
thread data before rebuilding SQLite projections. Thread deletion removes the
entire thread directory. A future user-level purge policy is intentionally outside
this PR and must define canonical event tombstones before selective sent-asset
deletion is introduced.

Authority deletion tombstones are retained for the life of the data directory so
stale scans cannot resurrect an opaque asset ID. They contain no filenames or file
contents. Bounded archival requires a future generation/checkpoint protocol and is
not performed automatically.

## Manual evidence plan

Before release, capture desktop, phone (320/360/390/430 px), tablet (768/820 px),
and short-landscape evidence for: mixed image/general-file staging, safe thumbnail
versus download card rendering, long Unicode names, four-item wrapping, attachment-
only send, failed upload retention, and keyboard/safe-area reachability. Verify the
download response headers in browser developer tools and repeat with VoiceOver or
NVDA. Automated browser screenshots and real software-keyboard behavior remain a
physical-device validation step.
