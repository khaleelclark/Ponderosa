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
commands and a lost POST response followed by GET-only reopening. Tests, builds
and browser execution are deferred until all implementation lanes are integrated.
