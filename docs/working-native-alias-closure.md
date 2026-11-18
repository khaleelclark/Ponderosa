# Working-folder and native Git alias closure

A whole working-folder selection can contain `.husky/pre-commit` and a sibling
hardlink to the same script. Git dependency capture alone sees only its hook
name; it cannot infer permission for another alias from the current link count.
The recovery planner now obtains complete package-declared hardlink rows from
`workingNativeAliasEvidence(package, finalDestinations)`. It keeps both names,
their selected root identities and the transported regular original. The native
planner rebases this closed component when its Git original is itself a working
alias. The writer verifies existing aliases and their complete census; it never
creates replacement working aliases or copies bytes to conceal the relationship.

Runtime metadata evidence is internal to this single import. `WorkingNativeMetadata`
contains protected native source plans, per-file/directory final readbacks and
per-node deferred metadata callbacks. It is never deserialized as permission to
read an old host or replay uncertain filesystem effects. Ordinary ISO timestamps
do not overwrite native nanosecond evidence. Exact filesystem metadata for a
shared node must agree with the Git mode/time source; chosen attributes, ACLs and
principal mappings remain explicit.

All ordinary/extended metadata staging runs after bytes, aliases, Git/provider
children and readable ownership preparation. Protected native files retain their
readable copy-phase mode until the shared native callback verifies their complete
bytes and aliases. Selected ACL/xattr changes and native exact modes/timestamps
apply through the same held inode, with exact chosen ACL readback after chmod.
Ancestor directory metadata waits until child verification is done. No source
permission is temporarily relaxed. Inaccessible descendants are not accepted
from an ancestor timestamp or cached checksum on later dispatch.

Agent and generic Branch paths share this metadata sink and stage metadata once.
Receipts remain applying while callbacks are queued; readiness and completion wait
for the native final phase. Failure retains destination bytes and source evidence,
records the partial result and never authorizes an automatic replay.

Regression source covers cross-root closure, missing/cyclic originals, a real
working hardlink with sub-millisecond file/directory timestamps, replacement of a
known alias while keeping the same count, and deferral of mode000/ancestor modes.
No tests, builds or typechecks were run in this implementation lane.
