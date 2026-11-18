# Source path provenance across hosts

Portable Git source paths are historical text. They are serialized with forward
separators as POSIX absolute paths, Windows drive paths (`C:/Repo/.git`), or
complete UNC paths (`//server/share/Repo/.git`). Drive letters serialize uppercase;
root drives and root UNC shares retain their trailing separator. Raw source
configuration values and pointer originals remain exact bytes, including native
Windows backslashes. The serializer runs only at the DTO boundary: live source
filesystem discovery, canonical-root checks, descriptor custody and recursive
module capture continue to use that source host's native paths.

`apps/server/src/portable-source-paths.ts` contains pure path operations. It selects
POSIX or Windows resolution from the source provenance, including Windows
current-drive rooted configuration paths, drive changes and UNC shares. Containment
and equality follow the source flavor; Windows comparisons fold case and POSIX
comparisons preserve case. Drive-relative names, device namespaces, incomplete UNC
roots, control characters and noncanonical carrier paths refuse explicitly.
No helper reads, resolves through the filesystem, or grants current access to a
historical source path.

Configuration directory/home/include provenance, captured association proof,
module storage/worktree provenance and source prefix mappings use these helpers.
After a source prefix matches, its portable relative suffix joins the explicit
current-host destination with the host-native path library. Native destination
validation and fresh-root authority remain current-host checks. Included
configuration compiles only from transported originals at those destination
paths. It never reads an imported Windows drive or UNC address from the current
host. Windows-equivalent duplicate source mappings are rejected.

The browser accepts Windows and UNC source choices and normalizes typed native
source separators into the wire spelling. Destination inputs remain native host
choices. Branch preview checks Windows/UNC declared nesting as well as POSIX
nesting; the server still establishes actual canonical destination custody.

Deferred regressions cover pure drive/UNC/POSIX operations, unchanged inert
Windows source/module/pointer carrier roundtrips, include/home/config mapping,
destination-only include compilation and browser path/nesting validation. No
Windows native execution is claimed. This restores Windows source provenance
transport; it does not add a Windows ACL, FIFO or POSIX shared-permission backend.
No tests, build, typecheck or native execution ran while implementing this change.
