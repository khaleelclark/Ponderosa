# Phase 2 Codex build — source and qualification checkpoint

Owner: Codex integration. Starting reviewed candidate:
`7a7504b0b25a79f72ab00cbc991a043606526467`. Source reviewed for this
checkpoint: `7fc0819ab5667aaf50c24b37eb9efec8a920c11b`. The
integration successor `3c05af480db31954f2bade56069b591b309473e4` changes only
these two documentation files; it does not change the tested product source.

Subsequent source commits `727e63f0e` and `6e2decd40` add and cover a
narrow no-effect Chat cleanup path. Commit `5f3076d4d` adds read-only capture
of verified hardlinked Git pack/index pairs. Commit `f9353d85b` handles one
exact absolute private-hook layout when external dependencies are selected.
The recorded full-suite results below remain pinned to `7fc0819ab`; they are not a full-suite verdict for
these successors.

The authoritative Ponderosa Behavior Bible 2 is Library file
`libfile_d5c0d1c163d88191be429a72ee3e95a5`, 530 lines, SHA-256
`ac314d93732e631bb042b8d3d2dc802ba08446812f99ba931023d2e02b14ab58`.
Later human direction assigns implementation to Codex subagents, requires
combining implementation before consolidated testing, allows mobile emulation
and keeps human-only checks from blocking independent work. Original worktrees,
paused package work, live services, data and credentials were preserved.
This is source work only: no deployment or production restart was performed.

## Current integrated checkpoint — 4 November, later

Product-and-test candidate: `fc8e031c701923d3088378801a177a410ff6c0f5`.
This section supersedes older current-state claims in the historical checkpoints
below; their exact-commit results remain useful evidence for those revisions.

- Tracked peer Requests now steer a busy Agent with an exact Request ID and
  host-issued injection freshness fence. Controlled stale calls before and
  after acknowledgement are rejected, the original task remains pending, a
  known unsupported delivery can queue for the next Run, and an uncertain
  delivery stays held. Human interruptions and tracked Requests are not batched
  together. Immediate peer instructions and questions steer by default;
  `messagePurpose:progress` and `messagePurpose:fyi` stay visible and do not
  interrupt, and explicit next-Run delivery remains separate. The provider tool
  description now reflects the actual Request behavior. Legacy unmarked progress
  or acknowledgements also steer; prompt guidance asks agents to classify them,
  but uncontrolled provider-driven conversational loops are not ruled out.
  A definitive unsupported peer steer queues once; a sole urgent peer message
  retains its urgency in the next provider's context. Provider acknowledgement
  and the fence are practical freshness checks, not proof of model comprehension
  or provider-supplied causal parentage; live-provider qualification is open.
- An explicit reviewed-continuation flow can carry the saved original task,
  steer, and available attachments into a fresh session after the human reviews
  unresolved effects. The original delivery outcome remains unknown; the
  successor is not an automatic replay. The currently qualified path is the
  built-in persistent Codex provider on POSIX with exact start/exit evidence,
  a single reviewable root and interruption, and available original files.
  Other providers, Windows, historical or mixed/multiple uncertain cases,
  changed evidence and uncertain source retirement stay held. An inert local
  Codex app-server fixture verified the original task, both attachment bytes,
  and reply on the original root; this is not a live provider qualification.
- Chat and Agent removal now report when logical removal succeeded but cleanup
  remains pending, distinct from a deletion that did not finish. This is not
  physical Chroma deletion. The 12 historical cleanup/rollback cases remain
  unresolved; one tests a foreign-data diagnostic and the others include
  physical cleanup or compensation expectations.

Combined validation on `cbda39e3`: offline install, full build and recursive
typecheck passed; affected server tests 55/55 and web tests 45/45 passed; the
full mounted matrix passed 100/100. On successor `9baab3f8`, updated agents and
server builds and 35/35 affected server tests passed. On successor `fc8e031c`,
updated server build and 31/31 peer and Chat workflow tests passed. The later
successors changed only the relevant server/agents code and tests; full typecheck
and the mounted matrix were not repeated on them. Evidence is under
`evidence/final-cbda-*`, `evidence/final-9baab-*`, and `evidence/final-fc8e-*`.
The controlled unsupported-provider case is not a live-provider qualification.

Combined validation on `791ef5c3`: offline install, full build and recursive
typecheck passed; affected server tests 48/48 and web tests 27/27 passed;
the full mounted matrix passed 100/100 (50 desktop, 50 emulated phone). Logs
are in `/tmp/ponderosa-codex-phase2-20261103/evidence/final-791ef-*`.
Fixtures and providers were inert; the loopback guard was process-level, not a
kernel network namespace. The full server suite was not rerun and Bible
acceptance, real-provider behavior and the 20-run reliability streak remain open.

The existing built-in memory path normally has one Chroma client and queue per
Ponderosa app, including forwarded MCP calls, but a second app or a direct client
can bypass it. The cleanup stubs do not themselves enter that queue. A conditional
sole-writer mode would require an explicit user decision to accept the risk of
another writer bypassing it, as well as actual check/delete/receipt implementation.
No such mode is enabled or assumed. An enforceable all-writer barrier or a
qualified atomic backend and verified migration are alternatives. No production
service or data was changed.

## Finite source checklist

| Owner | Integrated source at checkpoint | Remaining work or boundary |
| --- | --- | --- |
| Continuation | Reject unsupported blocked task closure; preserve original objective and steering, validate their exact lineage and canonical prompt block, hold unverified rollover failures, and offer a fenced human retry only for a proven never-started replacement. | Submitted or unknown outcomes remain held without automatic replay. Complete product and real-provider qualification remains. |
| Runtime | Native question bridge and safer cold-session command proof; Claude initialization/ownership checks; direct-Agent stream lookup; schedule-error redaction; bounded scalar compatibility and value-free argument errors in Ponderosa’s Local Memory bridge. | Native no-identity compaction lookup, host-fenced pre-start goal admission and external-effect settlement remain proof gaps. After a live Claude model change, Compact requires a reopened verified session. The user’s specific Claude symptom and real provider modes, switching and capabilities remain unverified. |
| Discovery and interface | Revision-bound recovery pagination; standalone direct-Agent Output chat; settings concurrency and streaming corrections; stored-audio single-range support; concise coordination and reviewed UI copy. | Full desktop/mobile flows, actual audio/voice behavior, accessibility, visual comparisons and an exhaustive UI-copy census remain unqualified. |
| Portability | Large-package recovery and reviewed import/export choices; Linux native metadata and mapped roots, links and Git layouts; exact nested-root ownership; reviewed mode forwarding; locally issued hook plan and duplicate-key JSON refusal; selected verified Git loose-object hardlinks; bounded dormant-module proof; bare-control custody and relative Git hook ownership checks. | Durable export-pool custody is Linux-only. Native metadata dialects outside Linux and macOS/Windows pool custody are unqualified. Live mixed-mode or multiple Separate owners sharing one physical root are refused before mutation. Nested bare capsules are held before destination writes pending descriptor-bound child custody. Nonempty absolute private hook paths remain refused except the exact captured private directory when external dependencies are selected; symlink aliases remain refused. Unvisited hardlink aliases fail closed, and live unreadable mode-000 originals remain unsupported. Dormant modules require a contained standalone parent with an unchanged indexed declaration, matching gitlink and selected bytes; ambiguous, modified, external or linked-parent cases remain held. Verified hardlinked pack/index pairs can be read, subject to bounded capture and verification. Device mapping, live socket restoration and an atomic snapshot against an independent writer remain unqualified. |
| Memory | 0044 adds durable scope-creation intents, exact binding and UUID/token checks for newly confirmed scopes, and visible holds for missing or uncertain data. Package/global import uses insert-only writes with verification. The host bridge ports bounded private.10-compatible scalar handling and permits authorized read-only access to existing finite zero vectors. | Chat cleanup can finish without a backend mutation when exact durable intents prove neither collection creation was dispatched. Stored-memory Chat, Project and Agent cleanup, package rollback and post-write compensation are held before destructive dispatch: the configured Chroma API has no proven atomic target identity/content precondition or enforceable exclusion. Ordinary saves, updates, forgets and conflict operations still have pre-read/upsert or delete races with independent writers. Earlier scopes lack retrospective UUID proof. Submitted creates without acknowledged identity, ambiguous legacy first provisioning, deliberate rebind and unsupported filesystem identity remain held. See [memory scope provisioning](memory-scope-provisioning.md). |
| Integration and verification | Retained old work was combined; Linux export tickets use held sparse-pool custody with small SQLite receipts; mounted cases are in the maintained runner. | A passing integrated repository suite and the remaining Bible acceptance evidence are outstanding. The current mounted matrix passed; the full product is not qualified or complete. |

For the export pool, completed expired slots can be reused. Unknown claims,
reader leases and preserved legacy files can retain charged capacity.
Per-chunk verification detects changed bytes before delivery but does not make
an independently mutable source an atomic snapshot. macOS and Windows fail
before durable-pool issuance pending safe writable-handle custody.

## Current implementation and remaining work — 4 November

The isolated integration branch now also includes source changes for pending
Branch resources, scheduler waiting, Output preference projection and deferred
publication. Branch plan ownership remains linked until completion; canceled
role cleanup checks exact ownership and role epochs. Recovery forms validate
notes before retaining commands and distinguish a failed local save from an
uncertain request. Agent import now retains an exact request fingerprint,
supports scoped lookup, and records a durable admission intent before queue
file mutation. A user can explicitly retire a proven unqueued intent while
its evidence remains preserved. A lookup with no durable record is still
inconclusive: an earlier upload can remain in flight. The import change adds
schema migration 0045; it is distinct from the unselected experimental memory
draft that previously used that number. These source changes were included in the later validation recorded below.

The twelve Chroma failures remain unresolved. The recorded cases comprise eight
Chat, Agent or Project cleanup cases and four staged import rollback or
compensation cases. The existing Chroma configuration has no established
identity-and-content-atomic deletion or enforced independent-writer barrier.
A never-dispatched Chat creation can finish without a backend mutation, but
that narrower path does not address the populated-memory failures.

The positive deletion and preservation cases use distinct seeded records and
some different wrappers, while assuming different outcomes from the same
backend class. The backend has no established atomic deletion capability or
writer-exclusion guarantee to justify the positive cases. Retain both safety
and successful-cleanup coverage; changing expectations alone would not fix
existing installations.

Remaining implementation and qualification:

- A safe cleanup/rollback capability or enforceable writer barrier for
  existing Chroma, with complete ownership and effect receipts, or a
  lossless, reviewed transition to a qualified transactional backend. The
  unselected SQLite prototype does not yet provide this transition. Its
  source is isolated and is not part of this candidate.
- Complete cleanup and package rollback for populated memory, including
  inventories beyond 10,000 records, foreign data, interrupted writes and
  restart. Preserve the original data on uncertainty.
- Resolve independently authenticated portable final-resource continuation,
  cross-platform durable export custody and the other boundaries in the
  requirement reconciliation. Do not infer replay authority from a package
  whose effect census cannot be authenticated.
- After all implementation is assembled, run the combined suite and address
  failures; then complete the Bible's reliability, native-provider,
  portability, performance, accessibility and blind-review qualifications.
  Actual production migration requires separate approval.

## Later integrated validation — 4 November

Product source candidate: `2f9bbf8f1967b8479ec3724ac455fc2594b36c45`.
Its full build and workspace typecheck passed; evidence is in
`evidence/final-2f9-{build,typecheck}.{log,exit}` under the isolated Phase 2
work area. The complete import-ownership file passed 13/13 and folder-directory
file passed 12/12 on that candidate; their logs use `final-2f9-import` and
`final-2f9-folder`. Three Branch files passed 42/42 (`final-2f9-branch`),
including three of the four earlier Branch failures. The earlier tree-deletion
case was replaced by two preservation cases; its successful deletion is not
proven. An independent audit found the replacement omits terminal assertions,
so its apparent pass does not establish the deletion completes. These runs
use disposable fixtures.

The most recent complete server lane ran on earlier source
`e1fb54865da1d65a6e62a4634be154305ebc6b13`: 2,582 passed, 32 failed, one
canceled and 19 skipped. It contains twelve existing Chroma cleanup and
rollback failures, four Branch failures, seven import failures and nine folder
fixture failures; the canceled case was import-related. Later focused tests
are evidence for their specific cases, not a complete current-source server
pass. See `evidence/final-e1fb-server.{log,exit}`.

Other completed controlled lanes are pinned separately: engines 60/60 at
`e54a1498`; web 802 passed and one skipped and tooling 77 passed and 23
skipped at `e1fb54865`; desktop and emulated-phone mounted checks 94/94 at
`5ef682942`. These do not establish a full current-source qualification. The
native Chrome test could not start inside the isolated sandbox because its
setuid helper was unavailable there; native-browser behavior remains unverified.

Production Ponderosa and observed local Chroma services share a host network
namespace. Loopback binding alone does not exclude other local writers, and
which backend production uses was not established. No live production service
or data was changed. The independent-writer barrier required for safe deletion
has therefore not been established; an in-process lock alone is insufficient.
For a published unfinished multi-Branch tree, root deletion is held before
mutation until Output recovery; whole-tree cancellation remains unsupported.

## Independent test-quality audit follow-up

The read-only audit of seven failure-cluster files and representative supporting
checks is at https://chatgpt.com/space/page_54624e545714819181c228d997a753f6.
It is a sampled audit, not an evaluation of every server test. Its concrete
findings resulted in test-only changes after product source `2f9bbf8f`:

- The Branch deletion test now requires the recovered acyclic parent and its own
  Chats and Agents to disappear while independently owned child resources remain.
  The cyclic case remains blocked. Both affected Branch files passed 31/31 in
  the isolated change worktree (`branch-deletion-assertion-focused.log`).
- Concurrent import uses a valid two-Agent organization and forces both
  admissions to overlap. It checks successful single-organization creation,
  exact data, and completed receipt replay after restart. It does not claim
  restart during the held admission (`concurrent-import-gated.log`).
- The sidebar test calls the actual selector on directory-route results and
  checks precedence and off-page membership. Directory and folder-presentation
  files each passed 12/12 in isolation (`folder-real-{directory,presentation}.log`).
  Appearance in both All and Starred sections can be intentional.
- A live inert-provider test calls product shutdown before fixture cleanup,
  checks process exit, then verifies uncertain Run state and no replay after
  restart. The provider file passed 3/3 in its normal isolated-worktree test
  environment (`fixture-shutdown-provider-normal.log`); network-namespace
  execution could not spawn detached children. Ordinary shared-fixture teardown
  still closes children first and is not separate product-shutdown proof.
- The memory binding test separately checks the specific incompatible-binding
  error and the generic no-deletion hold. It does not claim deletion diagnosed
  that binding or that populated cleanup is supported.

The integrated test-only successor `1cfe2e932d3223e09a5bbb5152c5c1d47a6c35be`
passed a fresh build and a combined run of the five affected Branch, Output,
import, folder and provider-shutdown files: 59 passed, zero failed, canceled or
skipped. Evidence: `evidence/combined-1cfe-{install.log,build.log,test.log,test.exit,hash}`.
A separate strengthened memory-binding case passed 1/1 on the same commit with
a disposable Chroma (`evidence/memory-binding-final-test.log`). The combined
run used inert providers and a process-level loopback-only socket guard; it was
not a kernel network namespace and cannot block code that bypasses libc.

These are focused evidence for their stated cases, not a full regression or
Behavior Bible qualification. The twelve populated Chroma failures and other
boundaries described here remain open.

## Independent follow-up — 4 November

Source candidate `fe16d4c7f8a505437bcec0a5a31855da73646c10` adds three bounded
corrections after `8dbcc2b0b`: the open-Chat Add Agents copy flow routes to
its explicit destination while preserving instruction review and product
scope; Branch update screens distinguish actual retry, hold and stopping states
and display both a retained error and a needed review action; repeated ordinary
push activity of one kind in one Chat shares a browser display tag while
retaining individual inbox notices and delivery receipts. Assistant reports,
Decisions and operational alerts remain separate.

The respective isolated checks passed before integration: cross-Chat server
authorization and instruction-conflict checks plus mounted desktop and phone;
Branch API/UI checks 150/150; push grouping and fake-device checks 4/4, with
headless Chromium retaining one same-Chat notification for 30 synthetic push
events. Push grouping does not reduce send attempts or establish a bound across
many Chats, and a late older message can replace the newer preview. Actual OS
banner and sound behavior remains unverified. See `evidence/notification-group-*`
and `evidence/notification-qualification-8db.md`. The latter also records
controlled direct/broadcast settings matrices and Assistant checks, with their
limits; these do not establish all of Bible section 18.

Final combined validation on `fe16d4c7f8a505437bcec0a5a31855da73646c10`:
offline install, full build and recursive typecheck passed; affected server and
UI files passed 154/154; the mounted desktop and phone matrix passed 96/96.
A disposable Chromium service-worker burst settled to one grouped browser
notification, `renotify=false`, and 30 distinct receipts. Its first immediate
snapshot saw the prior reply while the last receipt was still pending; by the
250 ms sample the final reply and receipt were present and remained stable.
Two immediate-snapshot assertions failed and their logs are retained; they do
not by themselves establish a lasting defect. These results do not qualify OS
banner/sound behavior. Evidence: `evidence/combined-fe16-*`. The mounted runner
blocked unmocked external requests, while the other lanes used a process-level
loopback guard rather than a kernel-enforced network namespace.

At the earlier `8dbcc2b0b` checkpoint, tracked peer Requests queued behind a
busy Run. The later integrated candidate above changes that tracked path. Changing them directly to steering could associate an older in-flight
result with a Request not yet seen. Current Claude acceptance proves a pipe
write rather than matching input delivery, and shared provider receipts do not
bind later tool calls to a specific injected message. This is a source-permitted
race, not a reproduced production incident. Delivery and call-order authority
must be established without replay before changing the current contract.

Read-only deployment inspection identified development Chroma at
`127.0.0.1:19788` and separate private-apps and Pinecone listeners at `:18810`
and `:18809`. Production's memory endpoint was not identified; these listeners
must not be assumed to be its backend. Loopback and a process-local queue do not
exclude other same-host writers. The JavaScript client reports 3.5.0; the dev
Python package reports 1.4.1, its launcher 1.3.1, and a disposable server's
version endpoint reported 1.0.0. These conflicting component reports do not
establish a live server version. No unauthorized writer was observed.

A proposed read-only parse of private provider configuration was denied by
automatic approval review because the files can contain credentials; it did not
run. The current hold and the narrow proven no-effect cleanup preserve data.
A broader maintenance cleanup or migration needs an enforceable all-writer
gate, drain, review, verification and separate production approval. No production
service was contacted or changed during this deployment check.

## Later continuity and recovery follow-up — 4 November

Product and test candidate `d83bee2abb029805624cbc3f5654751e28bd33bf`
contains four further changes:

- Ordinary browser push displays group by communication kind across Chats;
  individual inbox notices, settings and delivery receipts remain distinct.
  Important Assistant, Decision and operational notices remain separate. A
  controlled Chromium probe retained one ordinary display for a 30-Chat burst;
  earlier previews are replaced, out-of-order delivery can leave an older
  preview, and physical device banner and sound behavior was not tested.
- Branch deletion records and shows a safe diagnostic when final cleanup fails,
  retaining the deletion fence. Known blockers and safe SQLite codes are shown;
  arbitrary exception text is withheld because no general exact-value secret
  redactor was found. A database unable to write the diagnostic can prevent
  durable capture. Full readable real-cause coverage remains open.
- Import destination creation retains its exact durable request for explicit
  recovery, uses the owning Branch route, preserves malformed/conflicting
  journal entries, and prevents ordinary Branch Chat creation from silently
  adopting import-origin attempts. Cross-tab journal writes are not atomic.
- An unconfirmed human steer no longer causes an automatic interruption and
  reintroduction of the instruction. The exact original reply obligation stays
  pending, legacy queued recoveries remain held, and the user sees the hold.
  No reviewed safe retry or resolution for unknown effects is implemented;
  at that checkpoint automatic agent-to-agent Request steering was not implemented.
  The restart test invokes startup recovery directly, not a physical kill.

On predecessor `2469eca3ff5c561659f0ac43816319f9eb9eacbd`, the full build
passed and the affected mixed test command reported 173 passes and one test
file that failed to start because the web-lane loader was omitted. The mounted
matrix passed 98/98 (49 desktop, 49 emulated phone). Typecheck failed on an
unused parameter. The successor `d83bee2a` only removes that unused parameter
and its call arguments; its fresh full build and recursive typecheck passed,
and the previously unstarted delivery test passed 19/19 using the correct web
loader. The mounted matrix and other focused files were not rerun on that
successor. Evidence is under `evidence/combined-2469-*` and
`evidence/successor-d83-*`. Controlled fixtures and a process-level loopback
guard were used; that guard was not a kernel network namespace.

After explicit user approval, the previously denied, narrow provider MCP
configuration inspection ran once. It found no entries matching `local-memory`,
`local_memory`, or `chroma` in the inspected Codex and Claude maps. No endpoint
was identified; other names or configuration sources remain possible. No
credentials or config contents were printed and no live service was contacted.
This does not establish exclusive writer authority or resolve Chroma cleanup.

## Reviewed interruption and HTTP follow-up — 4 November

The source-and-test candidate `70ce427f7761e6c10847493223132d26ae53662d`
adds the following bounded improvements after `84832d60`:

- Instruction-conflict confirmation and optimistic Chat message identity use
  the existing SHA-256 fallback when Web Crypto is unavailable. A previously
  dispatched uncertain message retains that status after a later error; where
  Web Locks are available, outbox updates use the current locked record.
  Chromium on non-secure HTTP did not provide Web Locks, so cross-tab safety
  on that surface remains unqualified. The Chat test exercises the optimistic
  provider and mocked locked outbox, not a complete Composer/server send.
- A completed Run with an exact unconfirmed steering injection can now be
  inspected through the existing source-effects API. External effects remain
  unknown and the inspection neither resolves the hold nor authorizes replay.
- For built-in Claude and Codex adapters, a typed host authority-change error
  proven to occur before the steering write uses the existing known-refusal
  path. Other adapter and transport exceptions remain uncertain. If the Run
  fence has already been lost before the refusal can be persisted, the result
  remains held; custom adapters' explicit refusal reports retain their prior
  contract and are not newly qualified.

Offline install, build and recursive typecheck passed at that candidate.
Affected web tests passed 22/22, affected server tests 14/14, and the full
mounted matrix 98/98 (49 desktop, 49 phone). Logs are under
`evidence/final-combined-70ce-*`. Fixtures and providers were controlled; a
process-level loopback guard was used instead of a kernel network namespace.
These focused checks do not replace the full suite.

The reviewed-continuation design is not implemented. The preserved unwired
uncommitted draft is under `/tmp/ponderosa-codex-phase2-20261103/reviewed-steering`.
It cannot yet bind every provider-start admission to the exact successor Run
and fence across supported platforms. The proposed continuation must carry the
original objective and steer, preserve typed attachments, revalidate evidence at
claim and submission, and ask only about unresolved effects; it must not
silently replay the uncertain work. Existing explicit provider refusals already
use the ordinary retry path. Do not treat the draft as shipped or validated.

At candidate `70ce427f`, busy tracked Requests remained queued. Disposable
probes after a test-only policy flip demonstrated an older tool call could mark a
new Request complete before or after acknowledgement, and that an error exposed
its Request ID. Current provider/tool interfaces do not prove the causal link
between a particular injected instruction and its later update. These are
controlled experiments, not observed production incidents. Probe logs are under
`evidence/busy-request-*-probe-848.*`.

Further nonsecret deployment inspection did not identify the production Chroma
endpoint or a complete writer census. Chroma 1.4.1 source performs filtered
delete by selecting IDs and then issuing unconditional deletes; production's
version is unproven. The historical 12 populated-memory cleanup/rollback
failures remain unresolved. Source comparison is not a fresh full-suite result.
See `evidence/chroma-safety-assessment-84832.md`. No production data, service,
or provider account was changed.

## Provider attribution and reviewed-continuation follow-up — 4 November

Product candidate `5a5e4e0544b72ae847aded10faa5383fb48dfce1` records the exact
scheduler Run and fence on new provider-start admissions and tracked process
registrations, and checks that binding at settlement. Existing unbound starts
remain unbound. This is attribution, not authority to replay work or proof that
input was not sent. The stored conversation field is the Agent owner Chat; the
Run's own scope must be checked separately when it served another Chat.

The candidate passed fresh offline install, build and recursive typecheck; a
combined provider/process/scheduler/context run passed 171, failed 0, skipped 1
(native Windows Job on Linux). Evidence: `evidence/final-5a5e-*`. Two later
test-only commits add a real retained-session case; the complete provider-start
file passed 16/16 at `67451f195f67b8b06b0d957c205184742275ad11`, reusing the
unchanged product build. It checks the same live POSIX lifetime and session ID
across two Runs, each with exact Run/fence registration, and one start admission.
Windows Job coverage remains simulated. Tests used disposable fixtures and a
process-level loopback guard, not kernel network isolation.

At the earlier `5a5e4e05` checkpoint, reviewed continuation remained disabled. Then-current adapters and
scheduler do not enforce a qualified boundary from the final process/source
check through provider submission; one-shot inputs can reach the process before
registration callbacks, and delayed starts cannot be excluded merely by an
attribution receipt. Existing evidence does not establish that external effects
were absent. The isolated, uncommitted authority draft remains in
`/tmp/ponderosa-codex-phase2-20261103/reviewed-steering-current`; its removed
experimental route is preserved at `evidence/reviewed-steering-disabled-http.patch`.
The isolated mocked UI draft is commit `5d77e3c89a5ed9297e656fa9a1577a07a8c22c7d`;
it is not integrated or enabled. Any usable path must preserve the original task,
steer and attachments, reconcile conclusive cases, and request a decision only
on unresolved effects, without automatic replay.

At that earlier checkpoint busy tracked Requests still queued. A controlled
old-call probe with an explicitly caller-selected Request ID showed that an
ID/acknowledgement-only policy change can complete a new Request from an old
call. The current provider tool-call contract supplies no qualified causal
parent for the injected instruction. No test-only dispatch flip was integrated.
Evidence: `evidence/busy-request-explicit-after-ack-probe.{mjs,log}`.

Nonsecret service definitions identify three separate Chroma listeners at
`127.0.0.1:19788`, `:18810`, and `:18809`; no service was linked to production
and no all-writer gate was established. Point-in-time process/socket observations
do not exclude other past or future writers. The existing memory hold and the
12 historical cleanup/rollback failures remain unresolved. No production
services, data, or private configuration were changed.

## Recorded validation and open checks

- Earlier diagnostic builds and suites exposed failures and prompted fixes.
  The retained `verify-5` and `final-suite` commands both exited 1. They mixed
  source/build outputs and cannot establish the result for this checkpoint.
  Their logs remain under
  `/tmp/ponderosa-codex-phase2-20261103/evidence/`.
- The earlier mounted run recorded **54 passed and 24 failed** across desktop
  and emulated-phone cells. After fixture fixes, both the `4e376a809` and
  `7fc0819ab` mounted matrices passed **78/78**, exit 0. Latest evidence:
  `/tmp/ponderosa-codex-phase2-20261103/evidence/final-combined-mounted.log`.
  These controlled mounted cases do not establish the full mobile, visual or
  voice criteria.
- Supporting focused checks include **34/34** controlled pause and rollover
  boundary cases; **12/12** latest memory UUID and historical-owner checks;
  **50/50** schedule/ownership fixture checks; and targeted Linux Git, native
  command and controlled browser checks. These use disposable fixtures or
  controlled adapters and are not a whole-product or real-provider verdict.
- The isolated `7fc0819ab` build and workspace typecheck passed; evidence:
  `/tmp/ponderosa-codex-phase2-20261103/evidence/final-combined-build.log`,
  `final-combined-typecheck.log` and `final-combined-build.exit`. Its
  server lane finished with **2,564 passed, 12 failed and 27 skipped**
  out of 2,603 tests, exit 1. Eight failures require Agent, Chat or Project
  memory deletion; four require staged memory rollback or compensation.
  These remain unmet product requirements because the installed Chroma API
  supplies no proven atomic identity/content deletion precondition or
  independent-writer exclusion. Evidence:
  `/tmp/ponderosa-codex-phase2-20261103/evidence/final-combined-server.log`
  and `final-combined-server.exit`.
- Independent lanes at the same source passed as follows: web **802 passed,
  0 failed, 1 skipped**; engines **60 passed, 0 failed, 0 skipped**; tooling
  **77 passed, 0 failed, 23 skipped**; mounted **78 passed, 0 failed**.
  Their results and skips remain in
  `final-combined-{web,engines,tooling,mounted}.log` in the evidence folder.
  The server failure means these results are not a full repository pass.
- The earlier `4e376a809` server lane finished with **2,517 passed, 34 failed,
  27 skipped** of 2,578 tests. It stopped the normal runner before later lanes.
  Subsequent fixture and Git changes address identified failures, but memory
  cleanup/rollback cases remain genuine unmet requirements. This older result
  is not a verdict for `7fc0819ab`.
- The private.10 archive is experimental and Linux-only; the bundled package
  remains private.6. Ponderosa’s Claude uses its own per-Run bridge. Applicable
  bounded scalar normalization, value-free parameter diagnostics and authorized
  legacy zero-vector reads were ported without replacing the archive. Controlled
  bridge/host and disposable-memory checks passed, but no real Claude provider
  turn verified the user’s specific symptom. See
  [the exact comparison](local-memory-private10-reconciliation.md).
- The exact published ui096 0027 predecessor schema now has an independently
  reviewed admission fix. Its **22/22** focused checks passed, including
  unchanged-byte refusal of foreign and partial schemas. Disposable populated
  Core and Branches stores passed direct-server migration and restart; controlled
  messaging, idempotent retry and simulated canonical handoff passed. A combined
  Branches workflow, Chat and memory fixture passed authority-filtered reads
  with local ONNX and an owned loopback Chroma. The preserved evidence roots and
  precise scope are in [the upgrade reconciliation](codex-phase2-reconciliation-20261103.md#populated-ui096-upgrade-evidence).
- Remaining acceptance includes resolving the 12 server failures and a full
  current-source pass, further crash/recovery qualification, then 20
  consecutive complete controlled core-path runs on a fixed commit and
  environment. The streak has not started. The 10k-message/20-Agent performance profile,
  streaming and voice recordings, phone latency, memory recall/misuse, trigger
  and notification matrices, installation and accessibility checks, public
  client/framework comparisons and subjective judging remain unqualified.
  The active-load collector cannot establish a complete interaction population:
  terminal-delivery evidence is unsupported and ambiguous interaction IDs fail
  closed. No axe-core asset or screen reader was found in the bounded installed
  locations checked; those checks were not run.
- For each subjective test, use the Bible's written 1–10 rubric and descriptions
  of scores 3, 6 and 9. At least three independent blind judges use the same
  tasks and rubric, do not see one another's scores, and run on a different
  model from the feature builders. Human-only account/device checks go on the
  operator handoff; emulated mobile is acceptable under the later direction.

The full 32-commandment and 24 Build-behavior reconciliation is tracked in
[the requirement reconciliation](codex-phase2-reconciliation-20261103.md).
A focused pass, a source mechanism and a deployed, Bible-qualified behavior are
separate facts; none establishes an all-True verdict.
