# Native Git layout capture — Codex Phase 2

Source base: 659931a20. Owner: /root/runtime, branch
codex/phase2-git-layouts-20261103. This implementation follows Bible #8/#12/#15
and preserves current destination ownership. No test, build or typecheck has run;
all execution remains deferred until every implementation lane is integrated.

## Linked reftable

The carrier's existing common reftable stack now optionally includes a distinct
selectedWorktree stack. Each stack retains its own exact tables.list, ordered table
names and table bytes. Each stack's update sequence is independently validated;
both share aggregate decode/memory bounds.

Native Git 2.53 routes shared refs to the common backend and HEAD/pseudorefs plus
refs/bisect, refs/rewritten and refs/worktree to the selected backend. The pure
decoder now performs that same selection. Main-worktree private refs/logs do not
become the selected logical frontier. The raw common table inherently also contains
main-worktree records; those original bytes remain inert source data under the
selected common-storage grant. No other worktree directory is enumerated.

The source capture holds and rechecks both stack directories, their lists and
referenced files. Mapped package validation uses the same complete Git review
original instead of rejecting all reftable manifests. A private object-enumeration
view uses generated ordinary configuration and the validated logical selected
frontier; it never activates original configuration, hooks or main HEAD.

The separate inactive review repository now reuses the shared raw-stack writer.
It creates a new common store at .ponderosa-review-git and one fresh selected
worktree slot, then writes both original stacks byte-for-byte to their respective
backends. Its .git, commondir and gitdir records are newly generated local
associations; they do not copy source ownership. Minimal generated configuration
disables hooks/fsmonitor and contains no source settings, includes or remotes.
The common physical HEAD is the native reftable sentinel; logical HEAD and logs
come from the original selected stack, never an invented merged stack. This
preserves ref-prefix conflicts across original worktree backends and their
independent logs. Native activation remains a separate, explicitly reviewed action.

## Modules

Explicit role:module bindings are supported through the existing selected-root
transport. One module binding supplies the module working-root identity and exact
storage-root/relative path. Capture requires its .git pointer, same-owner held
directories, absent gitdir/commondir links, and exactly one literal core.worktree
pointing back to the selected working root. The association proof retains the
nonsecret scalar and full original config hash; it does not copy credential-bearing
configuration into topology records. Nested explicitly selected roots use their
own held descriptors and longest-root resolution with repeated identity checks.

Default Include Git also inventories repositories under the selected common
modules directory. Recognized child repositories use the same complete object,
ref, index, configuration, original-hook and metadata capture as their parent.
Native gitlink entries also identify old-form embedded .git directories, which
use the same capture path and record the native implied parent worktree when no
core.worktree setting is present. An explicit empty modules array records inspected
absence. Nested module repositories recurse through that same path. Initialized and
deinitialized repositories both retain their data. A missing working pointer is
observed as deinitialized; it is never inferred from failure to read an external
path. An external working root needs inclusion in the selected root closure
before its pointer can be read. Unknown/symbolic/special repository storage,
unproved associations and changing inventories refuse explicitly.

The optional modules carrier retains each storage name, source association,
source config hash, initialized state, relative working-root relationship, child
Git data and selected originals. Import validation checks every nested repository
and nonsecret original. The inactive review creates MODULES-REVIEW repositories
and retains source associations/originals in review metadata. Native activation requires integration with the separately owned recursive
destination writer, using fresh local pointers and current path grants. This
capture commit alone does not claim successful native module activation.

The recursion ceiling (16), repository count (1,000), directory/file count
(20,000), object count and existing 32 MiB family bounds protect synchronous
capture/decoding. They refuse before publishing incomplete data; no item is clipped.
Per-file drift and descriptor custody remain distinct from a coherent snapshot
across independent writers.

## Deferred verification

tests/organizations/portable-git-layouts.test.mjs, registered in the existing
inventory, creates disposable local Git repositories to check:

- Different selected/main HEAD and private refs in linked reftable storage.
- Exact dual-stack mapped provenance, corruption refusal and selected review HEAD.
- Automatic importWorkingFiles review creation with native cross-worktree ref-prefix
  conflicts, byte-exact common/private tables and selected HEAD/reflog equivalence.
- Initialized/deinitialized module object preservation and review recreation.
- Old-form embedded repositories and explicit inspected module absence.
- Explicit module bindings across nested selected roots, including tampered
  core.worktree refusal.

These are runnable regressions, not passing results. Native activation,
cross-platform metadata, source-independent atomic snapshots and whole Bible
acceptance retain their own consolidated verification requirements.

Primary contracts: installed Git reports 2.53.0. Source inspection used the
matching [reftable backend](https://github.com/git/git/blob/v2.53.0/refs/reftable-backend.c),
[repository layout](https://github.com/git/git/blob/v2.53.0/Documentation/gitrepository-layout.adoc)
and [submodule contract](https://github.com/git/git/blob/v2.53.0/Documentation/gitsubmodules.adoc).

The inactive raw-stack successor is based on integrated 4e7e7d99d and changes
only the shared writer's inert layout path and generated inert configuration,
plus its regression and this contract. No tests/builds/typechecks have run in
this implementation step. Source current ownership and native activation
configuration/grants remain separate.
