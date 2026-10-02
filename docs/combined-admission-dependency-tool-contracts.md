# Admission, dependency continuation, and tool contracts

Writer: `/root`. Branch: `fix/admission-dependency-tool-contracts-20261002`.
Worktree: `/Users/khaleel/Projects/Ponderosa-worktrees/admission-dependency-tool-contracts`.
Approved, unmodified base: `060348ddb28cf7d0dae31cbd8ff6bd338f567855`.
Scope: the ten requirements in the user's combined specification. No merge or
deployment authority; live services, assignments, provider state and browsers
are excluded. One writer; reviewers must use separate read-only checkouts.

## Baseline evidence

Exact-base `pnpm verify` passed on macOS, Node 24.21.0: 934 passed,
7 platform/opt-in skipped, zero failures; retained log:
`/tmp/ponderosa-combined-exact-base-verify.log`.
Disposable base probes are retained in `/tmp/ponderosa-combined-*-base*.mjs`
and `/tmp/ponderosa-combined-base-probes.mjs`.

- Exact parent Request + completed dependency + progress + normal completion:
  parent changes from `in_progress` to `outcome_unknown` while one canonical
  dependency wakeup remains pending.
- Disabled provider creation: managed and human opening assignments return 200
  and add canonical executable work. Disabled queued work projects as idle.
- Update tool advertises `waiting`, but its schema accepts `waiting_dependency`.
- Controlled late implicit return, explicit send and exception: deadline returns
  504 and retains admission correctly, but Fastify reports duplicate responses
  or a late promise exception.
- Real disposable Chrome: `END` and `Unidentified` return 500; `End` and
  `Control+A` succeed. No existing browser was used.
- Provider-supplied command exit 1 / SIGTERM metadata is lost in normalization.
- Explicit RATE_LIMIT_EXCEEDED envelope with INVALID_ARGUMENT is classified as
  invalid input.
- Missing Codex executable is reported as unauthenticated with login advice.
- Outside-root import rejects correctly with 403; the missing safe-repair and
  environment guidance is an additive capability, not a containment defect.

The import harness initially lacked AssetStore and failed before dispatch; it
was corrected and the real-route 403 observed. That harness error is not a
product finding. Richmond's interruption cause remains unproven. Do not change
recovery semantics on that evidence. No historical Request reopening or live
data repair is authorized.

## Implemented contracts

| Requirement | Change and safety boundary |
| --- | --- |
| Exact dependency continuation | Normal completion consults the exact Request/Join owner, scope, lifetime and pending wakeup. Direct, answered and Join-derived Requests share the check, including after progress. Cancelled, superseded, expired, historical/unrelated and invalid-owner continuations do not qualify. Provider-loss/cancellation fences are unchanged; historical `outcome_unknown` Requests are not reopened. |
| Disabled-provider admission | New executable human/managed creation returns structured `409 provider_disabled` without canonical residue. Committed replay precedes admission; configuration-only creation remains allowed. Preparation and prelaunch recheck existing operator authority. An uninjected claim is fenced and its exact Activations returned to the queue without consuming failure retries. Already-running work is not cancelled. |
| Truthful queue status | Health and Team Directory share bounded, payload-free admission-blocker DTOs. Active/preparing work, Decisions, dependency waits and provider backoff take precedence. Read models use existing scheduling/auth observations, not new probes or polling. |
| Tool contracts | One shared ten-value Request-update enum includes `waiting_dependency`; invalid kinds receive bounded accepted values. Bare message convenience exists only for one canonical authorized default. Immediate recipients require Collaboration; `next_run` and correlated Request results retain their separate contracts. Steering receives the same guidance. Exact scheduler injection text/hash/source identity is durable. |
| Handler deadlines | Late implicit returns, explicit sends and exceptions cannot generate a second response. Admission stays held until real handler settlement. Streams retain existing behavior. Auth probes coalesce and their actual owned process trees are drained before timeout settlement. |
| Browser input | The shared boundary narrowly validates key notation and returns actionable structured 400s. Unicode, supported shortcuts and navigation remain supported; stale page/control and real transport failures stay distinct. No consequential action is automatically replayed. |
| Command outcomes | Optional provider-supplied exit code/signal survive engine normalization, strict projection, persistence and activity details. A command failure remains a tool result, not an invented terminal provider failure. The same Run can correct it, publish canonical Communication and complete. |
| Connector throttling | Supported explicit structured `RATE_LIMIT_EXCEEDED` envelopes precede conflicting generic codes. Finite nonnegative delays are converted to milliseconds and capped at 300,000. Original output is retained. No new scheduler delay, cross-connector budget, write replay or provider/auth classification is introduced. |
| Environment/publication facts | Actual cwd/platform, five bounded executable observations and an optional reviewer-owned directory under an existing import root are recorded in the input manifest. No install, directory creation, copying, authority expansion, secrets or shell history. Outside-root rejection explains safe alternatives; symlink containment remains enforced. |
| Startup/auth/interruption | Probe error/timeout is unknown, not confirmed logout. Coalesced observations expose bounded stale last-known evidence. Interruption diagnostics record exact Run/fence, session generation when observed, process identity, observed terminal status and a known host operation where available. Only explicit provider `completed` is successful; interrupted/missing/unrecognized terminal statuses fail closed. No pressure guard or automatic recovery is added. |

### Shared fields and durable evidence

- `ToolResultEvent`: optional signed-32-bit `exitCode`, bounded `SIG…` signal,
  and finite `retryAfterMs` in the supported range. New fields remain subject
  to the closed strict event boundary; historical events without them work.
- Error events alone may carry `terminalStatus` (`failed`, `interrupted`,
  `unknown`). This is observed failure evidence, not completion authority.
- `QueuedAdmissionBlockerDto` is metadata only. Auth cache reuse is 30 seconds
  for known observations and 5 seconds for unknown/error; explicitly stale
  last-known evidence expires after 5 minutes. Reading status does not probe.
- Environment observations cover `python`, `python3`, `node`, `git`, `pnpm`,
  at most 64 PATH entries and 8 Windows extensions. Report-root selection
  examines at most 8 configured roots, rejects symbolic/non-directory roots,
  and proposes a stable Agent-owned path outside the actual working checkout.
- Migration `0017_exact_prompt_injections.sql` adds nullable exact text and
  source-manifest columns to the existing injection ledger. New packets retain
  exact Run/injection/kind/Activation identities and their submitted text/hash.
  Historical hashes remain unchanged; missing historical text is not invented.
- Runtime diagnostics are observations, not a competing lifecycle authority.
  Session generation is capped at 256 characters, birth marker at 128, and
  host operation at 160. Missing observations remain missing. Existing exact
  Run fencing and teardown authority decide outcomes.

## Reproduction and qualification

The runnable comparison harness is `apps/server/test/combined-spec.check.mjs`.
Pass a separately built checkout root as its sole argument. It records real
route/store observations rather than interpreting every intentional rejection
as a test failure. It uses disposable data and launches no provider.

| Evidence | Exact base | Candidate |
| --- | --- | --- |
| Dependency completion + owner progress + normal completion | Parent becomes `outcome_unknown`, one pending wake | Same parent stays `in_progress`, one pending wake |
| Disabled managed/human executable creation | 200 with canonical residue | 409; Agent/Communication/Request/Join/Activation counts unchanged |
| Disabled queued health | Idle/queued-delivery projection | Blocked with `provider_disabled` metadata |
| Request tool contract | Contradictory `waiting` description | Description, schema and error guidance agree on exact enum |
| Delayed implicit/explicit/throwing handlers | 504 plus duplicate-response/late-promise diagnostics | One 504; admission 503 until actual settlement, then 200; late exception logged once |
| Command exit 1 / SIGTERM | Metadata discarded | Strictly projected tool result retains both, without terminal failure |
| Conflicting connector codes | `invalid_input` | `connector_rate_limit`, bounded 12,000 ms metadata |
| Missing Codex executable probe | False logout/sign-in advice | Explicit unknown, no sign-in claim |
| Provider terminal normalization | Interrupted/unknown/missing become `turn_done` | Only `completed` does; other states remain failed/unconfirmed |
| Disable during actual asynchronous Run preparation | Synthetic provider launches once despite disable | Zero launches; exact work queued, no failure retry consumed |
| Real Chrome keyboard boundary | END/Unidentified 500 | Structured 400; valid keys/Unicode work; stale/control/transport failures remain distinct |
| Outside-root import | Correct 403 | Same denial plus bounded safe-repair guidance; authorized isolated publication remains valid |

Retained local evidence (not committed fixture data):

- `/tmp/ponderosa-combined-exact-base-verify.log`
- `/tmp/ponderosa-combined-base-probes-final.log`
- `/tmp/ponderosa-combined-fixed-probes-final.log`
- `/tmp/ponderosa-combined-prelaunch-base.log`
- `/tmp/ponderosa-combined-prelaunch.log`
- `/tmp/ponderosa-combined-browser-base.log`
- `/tmp/ponderosa-combined-browser-fixed.log`
- `/tmp/ponderosa-combined-process-restart.log`
- `/tmp/ponderosa-combined-final-focused.log`
- `/tmp/ponderosa-combined-final-verify.log`

Final candidate `pnpm verify` passes on macOS, Node 24.21.0: **986 passed,
7 platform/opt-in skipped, zero failures**, including typechecks and production
builds. Focused qualification passes **55/55 tests**. Coverage includes canonical lineage
and terminal counts across request/request-update/join sources, impossible
outcomes and negative lifetime/owner/cancellation cases; a combined dependency
wait/progress/rollover/exact wake trace; creation replay/presets/prelaunch races;
accepted Run survival after disabling intake; exact injection migration;
same-Run failed-tool/correction/Communication/completion; real owned probe and
RPC process cleanup; actual Chrome input; authorized import and symlink denial.

The dependency restart check starts two separate full application processes.
The second consumes the exact pending wake and produces one terminal result on
the original parent. It is a clean process restart, not a provider crash test.
The exact-base tree remains clean. No verification failure is excluded: early
harness/setup defects and missing assertions were corrected, and the final
repository verification was rerun. Intentional baseline regression failures
are reported as before evidence, not passing tests.

## Limits and next gate

- Richmond's interruption origin is still unproven. This PR does not repair
  historical work, blindly retry injection, change provider databases, or claim
  to resolve Richmond's incident. Artifact-capture warnings likewise do not
  authorize recovery.
- Canonical rollover and exact handoff preservation are tested; an actual
  provider's low-water compaction into a fresh session is not qualified here.
- Provider launch/steering qualifications use controlled adapters; process
  qualifications use owned synthetic RPC/probe processes. They do not establish
  live concurrent managed-provider reliability.
- Actual isolated Chrome was used. Installed Safari, physical Galaxy/iPhone,
  native Windows, Linux host deployment and package qualification were not
  repeated. Platform/opt-in skipped tests are not passes.
- No live services, shared provider state, assignments, browsers, user data,
  dev, experimental or production were touched. Temporary fixture resources
  were owned and cleaned; evidence logs and the exact-base worktree are retained.
- Independent review remains pending. The user requested a review prompt for
  their separate reviewer. Do not describe this implementation as independently
  approved, merge it or deploy it without that next explicit authorization.
