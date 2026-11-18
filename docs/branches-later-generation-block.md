# One-resource later-generation admission: exact contract block

Source baseline: 72f46799a65276f37ea2d46f19097206fcca3750. This is an
implementation blocker report, not later-generation support or runtime evidence.

## Incompatible requirements in the current singular Runtime contract

Consider one resource Step S whose generation 0 used Chat C0 and Agent A0. A failed
Request Q0 causes the actual `finish` retry policy to set `retry_draining=1` and
create the next attempt. Canonical cleanup deletes A0/C0; `resourceRetired` replaces
the pointer with generation 1. Generation 1 uses distinct C1/A1 and Request Q1.
The source package for the issued generation 1 is scoped to C1 and contains A1.

An exhaustive retained host cut must preserve Q0 with its actual C0/A0 audience,
not rewrite Q0 as work originally issued to A1. Current singular admission rejects
that exhaustive cut independently at these canonical boundaries:

1. `CoordinationV3DestinationAdmissionAuthority.reserve` requires every captured
   Request and Join to use `custody.sourceChatId` (C1). Q0 uses C0. The same method
   requires exactly one captured current resource scope.
2. `stageInTransaction` requires `agentMap` keys to equal `custody.agentIds`
   exactly (A1), and requires every historical Request/Join/suspension participant
   to be a key in that same map (also A0). For a fresh generation A0 != A1, these
   requirements cannot both hold. Adding A0 to the package would restore a prior
   generation Agent as current, contrary to this task.
3. `restoreValidatedHostGraph` maps every historical Request audience through that
   same destination Agent map and inserts every Request into destination current
   coordination state. It has no evidence-only historical Request/Chat identity
   partition. Merely teaching the Branch replay codecs about retries cannot change
   this canonical writer contract.

Dropping Q0 or putting it only in an unchecked side object would evade exhaustive
host-root and current human disclosure requirements. Relabeling Q0 as C1/A1 would
change its original audience. Passing A0 through without a fresh map would bypass
current destination authority and canonical Request ownership. None is implemented.
A group API for multiple *current* imported resources does not by itself resolve
this prior-generation evidence-only identity distinction.

## Branch-side evidence gaps, separately owned

The prospective `resource-generation-retired:<step>:<generation>` command preserves
resource/member/context/operation/audit rows before pointer replacement. It does
not seal Q0's immutable host closure or package custody before Chat deletion, nor
record independently verified historical provider exit. `captureBranchHostCut`
currently reads Request roots from live canonical tables and rejects a root whose
Chat no longer exists. Calling it after cleanup cannot reconstruct missing scope.
The existing capture/seal path only accepts replayable issued waiting/completed
frontiers; a failed generation awaiting retry needs a distinct retained historical
exit capture that shares canonical provenance and custody, not an invented receipt.

Serial and parallel shared replay also need explicit failed-attempt settlement,
retry scheduling, old-generation retirement, and current-generation opening
transitions. Existing single-issued-root validation and current-operation matching
are intentionally unchanged. Current-generation fresh Agent maps must remain exact;
historical identities must remain typed evidence and must not become current members.

## Required canonical boundary before a complete implementation

Runtime must define a validated partition between current executable Request roots
and retired evidence-only Request roots, including original Chat/Agent identities,
immutable provenance, full selected update prefixes, disclosure/current authority,
receipt/readback and no dispatch for historical-only roots. Branch can then retain
the exact prior cut before cleanup, bind native drain and actual package custody,
validate both generations in shared replay, and pass only current imported identities
to the composer while carrying prior evidence in the canonical approved partition.
This is a singular authority change, not permission to independently admit resources
or add another replay/proof system. Existing strict refusal remains intact.

## Deferred regression source delivered in this slice

`tests/branches/historical-checkpoint-rewind.test.mjs` extends the existing real
SQLite fixture with an optional actual fresh-context retry policy. Four deferred
ASYNC/SYNC × serial/parallel cases drive canonical failed Request → next attempt →
Agent/Chat cleanup → `resourceRetired`, inject an immutable journal conflict and
assert rollback preserves generation/member rows, then assert exact retirement
operation/context/audit retention and readback after reopen. No fixture executed.
Readback models a lost response; retrying retirement against a new generation is
not claimed to be an idempotent old-generation command.

Complete later-generation capture/retire/review/admit/readback, custody/host tamper
and admission lost-response fixtures are **not delivered** because no legitimate
canonical admission contract can currently express this cut. Existing generation-0
composer chain fixtures remain unchanged. No test/build/typecheck/preparation or
Node/native/browser execution, install, merge, push, deploy or web write performed.
