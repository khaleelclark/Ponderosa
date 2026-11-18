# Codex Phase 2: complete package transport and recovery

Source base: 7a7504b0b25a79f72ab00cbc991a043606526467.
The preserved d94037fc lossless transport implementation is integrated without
changing its paused source worktree. Its successor HTTP-deadline, original
instruction retention and clipboard changes were inspected and composed separately.
Historical qualification documents retain their original scope; they do not
qualify this combined candidate.

Large package JSON is parsed incrementally in both the server worker and browser.
Compressed originals retain exact decoded-size and hash validation; decoded and
wire limits remain separate. Package routes have a bounded longer response budget
and disclose uncertainty instead of allowing a new import after a lost response.
Clipboard copying admits at most 8 MiB; larger packages use the complete download
with all selected data families retained.

Branches installation commands now use the browser's transactional IndexedDB
object store rather than putting the complete package in localStorage. The exact
package, preview, destination bindings and consent body survive reopening.
Earlier localStorage commands remain readable and are never cleared implicitly.
A conflicting existing command or storage failure blocks confirmation before POST.
Recovery reads the exact original installation status; it does not repeat import.
Storage quota remains browser-controlled and failures are shown explicitly.
Package equality traverses admitted JSON instead of building whole-document strings.

Regression sources cover large-object persistence, conflict preservation, legacy
commands and a lost POST response followed by GET-only reopening. Current
qualification results must be read from the combined candidate evidence.


## Held export staging

A download ticket retains its original staged bytes for up to its 15-minute
retrieval lifetime. Expiry, cancellation, uncertain preparation and failed
serialization do not authorize pathname deletion: an independent writer could
replace a name between an identity check and unlink. Retained payloads, manifests
and request claims remain on disk and count against the 16-slot and 4 GiB
staging bounds after restart. At capacity, the response identifies the local
staging directory and says that files are retained. A future qualified backend or
explicit operator-reviewed recovery is needed to reclaim them; no automatic
deletion is claimed here. This is a normal-use limitation: 16 successful ticket
exports, or 4 GiB of accumulated staging, can exhaust capacity even without an
error. A failed request claim also remains held. Ordinary direct JSON exports use
a bounded stream and do not consume durable download-ticket slots; a direct
response made with a request ID remains unconfirmed and must not be recaptured.
The bound charges observed retained files and this service's writes; it is not a
physical filesystem quota against an independent writer.

On Linux the original data directory is opened and checked before staging mkdir;
the staging directory is then held by its own descriptor. A changed data or
staging directory refuses rather than using a replacement. On macOS and Windows,
a live registered native data root supplies a handle-relative child authority;
same-process users share that child lease by exact directory identity and release
it by reference count. An unregistered non-Linux root is refused before staging
mkdir. The portable path remains subject to native platform qualification.

Manifest and request records are read through held regular-file handles with a
bounded read and before/after descriptor and named-inode, link-count, size,
mtime and ctime checks. A ticket linked to a request ID is returned as completed
only after its matching stable request record is verified. A changed, missing or
conflicting record remains held and cannot authorize recapture.

New ticket payloads are read back through the same held descriptor and checked
against the serialized SHA-256 before a ticket is published. A changed or failed
allocation is retained and conservatively exhausts byte capacity until review.
