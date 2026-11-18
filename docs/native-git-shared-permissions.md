# Native Git shared permissions

Explicit Git activation recreates native storage in fresh owned destinations.
New empty directories and generated files record their normal kernel creation
modes before being restricted for copying. This retains actual umask and inherited
default-ACL effects rather than attempting to reconstruct them from a mask alone. After the complete
configuration/include closure and private worktree context exist, a read-only
native `git config --includes --null --list` query resolves the effective
`core.sharedRepository`. This preserves native conditional-include and worktree
precedence; merely scanning the common captured file cannot do that.
The query uses only the newly owned destination, an isolated environment,
disabled system/global configuration, and disabled hooks/fsmonitor. It never
executes a hook, filter, provider process, network operation, or source command.

The Linux 64-bit permission implementation follows pinned Git 2.53 primary
semantics: [setting interpretation](https://github.com/git/git/blob/v2.53.0/setup.c#L1861),
[permission calculation](https://github.com/git/git/blob/v2.53.0/path.c#L698),
[immutable loose objects](https://github.com/git/git/blob/v2.53.0/object-file.c#L775),
and [packed object defaults](https://github.com/git/git/blob/v2.53.0/odb.c#L64).
Named group/world modes add their grants to the observed ordinary creation modes. Explicit octal modes replace ordinary read/write bits. Immutable
object files retain their read-only character. Directory read access gets matching
search access and Linux group-access directories get setgid inheritance.
Captured original file modes/timestamps, including executable hooks, remain exact
overrides; they are not flattened to the generated-file default. Outside storage,
new worktree `.git` pointers use ordinary umask permissions.

Every application checks the actual current owner and observed destination group,
current group membership, retained inode identity, and exact syscall readback.
There is no chown, sudo, source UID/GID adoption, or fallback that silently drops
setgid or sharing bits. Newly generated nodes are applied through pinned
no-follow descriptors. Child module repositories apply their own native policy;
a parent never overwrites their permission modes. Working-root metadata is left
for the existing later finalizer. An application/configuration failure retains
the new destination and its incomplete receipt rather than retrying or deleting
uncertain state.

Shared POSIX permission semantics are qualified for Linux 64-bit only. An active
shared setting on other platforms explicitly refuses native activation; an
ordinary non-shared transport path makes no new POSIX guarantee there.

Deferred regressions compare group/world/octal/umask recreation with actual
installed Git-created nodes, check immutable objects and executable hook originals,
retain working-root modes, exercise active worktree settings and relocated
conditional includes, compare kernel default-ACL inheritance where supported, and
prove a later inode mismatch prevents earlier mode changes. No native execution, build, typecheck, or tests were run
while implementing this change. The shared `openPortableRegular` helper from the
portability lane must be integrated before consolidated validation.
