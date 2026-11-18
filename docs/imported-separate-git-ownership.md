# Native Git in imported Separate copies

Bible 2 #4, #8, #12, #15, #17 and #23 apply. This extends the existing
working-copy service and shared Git recreation engine.

Native Git activation can recreate selected Git data in a fresh managed Separate
copy even when the destination Chat already has a Shared repository. The importer
allocates a new managed root and an Agent-local branch identity. Its optional
`workingCopy.repositoryRoot` is issued locally, must equal that Agent's exact
managed root, and is never transported or accepted as an imported path setting.
Existing Shared refs, index, configuration, hooks and files are not changed.

The physical sequence is explicit:

1. Allocate fresh Shared/Separate roots and keep Separate Agents unavailable.
2. Restore selected files, aliases and harness settings, preserving final
   directory/root metadata for the end.
3. Apply the complete selected Git/common/private/configuration closure once,
   using the existing recreation planner and partial-result receipts.
4. Create each Separate Agent's new owned branch at the selected source HEAD.
   Existing source branches, tags, objects and staged index remain intact. An
   unborn source receives only a local empty ownership commit; its staged index
   is preserved. No source branch/worktree ownership receipt is adopted.
5. Verify local directory/pointer Git storage and every initialized child module's exact `.git` anchor and mark the Agents ready. Only
   then apply final ordinary permissions, timestamps and selected ACL/xattrs.

Git path choices are reviewed against the user's selected recovery root map and
relocated to the corresponding server-issued live roots. They cannot target an
unselected existing folder. Lifecycle Git commands suppress hooks and fsmonitor;
they do not execute imported hooks, checkout filters or signing commands while
constructing ownership. The user's later native harness remains able to use the
explicitly activated settings.

Creation intent and branch markers are stored before ref mutation. Applying
receipts become complete only after Git data and local branch adoption both
finish. Failures retain the package, managed paths and exact partial receipts;
staged phases are not treated as authorization for an automatic replay after a
restart. Fresh metadata application requires current local root inode custody
and a working-folder fence, including Separate copies in existing Projects.

If storing an incomplete receipt also fails, adoption still attempts every
receipt. The original adoption error remains the wrapper's cause and secondary
storage errors are attached separately. An unavailable or released independent
copy refuses generic working-copy Retry; only its exact import operation can
establish recovery. Its `repositoryRoot` ownership discriminator is preserved.

Typed parent/child working-root relations use the existing working-copy service.
The caller first stages the fresh parent and holds its working-folder fence.
`reserveImportedContainedRoot` receives only a relative path and a canonical
parent Agent, records `creating` before allocating, then records the observed
child inode as `created`. A contained Shared destination must register its
Project at that exact reserved root. A contained Separate destination gets a new
local copy/branch identity at the reserved path. Binding records one exact child
identity as `binding` before changing it and `bound` afterward; it cannot assign
the root to another Agent after an uncertain write.

The child stores locally issued parent/child inode custody in `importedParent`.
Neither absolute source paths nor source identity receipts authorize it. Exact
`created` receipts can be checked and rebound after a restart without repeating
directory creation. Unconfirmed `creating` or `binding` outcomes stay held with
their paths intact. Parent intermediate directories may be reused only when
this service itself created and retained their exact identities. Contained roots
retain the same data-preserving cleanup behavior as independent imported roots.
`inspectPreparedImportedRoot` verifies canonical Agent, fence and allocated inode
before the carrier can skip reallocation. Shared contained population validates
that same issued custody before native activation. Without native activation,
completion initializes only staged Separate repositories after regular files;
staged Shared destinations stay ordinary folders and no source Git is adopted.

Removing the Agent releases its working-copy authority and records `removed`
with the retained repository path. It preserves the imported repository and all
its user data, including dirty or staged originals. Project cleanup also leaves
these retained repositories in place. There is no recursive deletion of this
data. Ordinary Project-linked Separate copies keep their existing guarded
cleanup rules.

The source regression in `tests/organizations/portable-git-recreation.test.mjs`
covers fresh branch ownership, source tags and staged/unstaged originals,
unchanged existing Shared state, local-path rejection and retained-data cleanup.
Execution is deferred until all implementation is integrated. This document does
not claim a passing test, deployment or universal provider/platform acceptance.
