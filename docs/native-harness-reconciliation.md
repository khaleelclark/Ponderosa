# Native harness source reconciliation

Codex successor: [runtime completion](codex-phase2-runtime-completion.md) adds native
user-question callbacks, truthful diagnostic cancellation/cleanup holds and exact
redacted control causes. The source-only status and external proof boundaries below
remain; this successor does not promote any execution verdict.

Baseline: `f9f964ff50dc064d21e3e06cf1055858037ba9ac`, 2026-11-03.
Bible-2 SHA-256: `ac314d93732e631bb042b8d3d2dc802ba08446812f99ba931023d2e02b14ab58`.
Scope is Bible #1/#4/#12/#13/#25 and the eight named native groups.
This document records source presence and the corrections below, not execution results.
The root implementation inventory is unchanged.

## Finite source checklist

| Area | Source path and current behavior | Disposition |
| --- | --- | --- |
| Native approvals (G1) | `native-approvals.ts`, both provider sessions and `routes/provider-run-executor.ts` carry the original request/session/turn into explicit human consent. Cancellation rejects late consent; one callback cannot amend saved permissions. | Already implemented; preserved. Native disk settings/hooks stay with the CLI. Unregistered SDK callbacks refuse explicitly. |
| Goals (G2) | `codex-native-actions.ts`, `codex-app-server.ts`, `routes/provider-commands.ts` support exact retained-session inspect, paused edit, pause and clear. Native usage/budget data is retained. | Already implemented for paused operations. Active creation/resume and automatic continuation remain blocked by the specific external admission contract below. |
| Plan/review/schema (G3) | `native-command-selection.ts`, canonical human intake, `provider-run-executor.ts` and `codex-native-actions.ts` select one immutable human command and dispatch it under its Run. Review preserves retained context; plan/diff/review have shared typed projections. | Already implemented. Corrected queued observation identity so a fast completion cannot erase earlier plan/review/task receipts. |
| Claude controls (G4) | `claude-controls.ts`, `claude-stream-session.ts` and `routes/native-controls.ts` use correlated controls on one reader and exact retained runtime/session/Run checks. Interrupt acknowledgement does not mean process exit. | Already implemented; preserved. Start now checks current authority around a model-control wait. |
| File checkpoints/fork (G5) | `claude-file-history.ts`, `codex-transcript-fork.ts`, native history authority/routes and shared DTOs implement catalog, tracked-file preview/rewind, fork preparation, future-session tracking and exact original-key reads. Physical preview, current write policy, empty destination and no-replay checks remain. | Already implemented. Claude backups must actually have been observed; Codex transcript fork is distinct from file restore. No portable Codex file-only rewind contract was established by the pinned research. |
| Typed input (G6) | Shared `typed-input.ts` validates immutable original/derived bytes; both sessions receive authorized current descriptors. Claude media echoes still pass through `ClaudeReplayFraming` on the existing reader. | Corrected Claude validation/seed/lifetime ordering and current-Run checks. The steering caller now supplies the existing authority callback to both providers. |
| Browser observations (G7) | Browser authority, driver/session services, observation routes, shared DTO/SDK and existing UI supply owned console queries and explicit recording/publication. | Present in the released source. No replacement browser or observation subsystem added. Existing recording storage/error and console-shortening disclosure are retained. |
| Native pending work (G8) | `claude-task-lifetime.ts`, `claude-task-stop.ts`, `codex-background-tasks.ts`, native task routes/authority and shared DTOs retain the original Run and expose exact inventory and one-attempt human stop. | Already implemented. Corrected Codex queued receipt handling and Claude's startup declaration for the mounted per-task Stop UI; acknowledgements still never claim process drain, source completion or effect settlement. |
| Native authentication (#25) | `auth.ts`, engine registration, native launch environments and retained normal contracts use the existing CLI; no separate credential store or billing selector. | Corrected Claude observation to ask the CLI rather than infer its selected login from a home file/environment key. Existing retained-auth compatibility checks, Agent identity/history and native configuration are preserved. |
| Crash recovery (#1/#12/#13) | Existing context recovery reservations, exact known-ID completion readback and durable host-effect receipts remain separate authorities. | Preserved. Missing native identity/effect evidence remains unknown; no new journal is represented as provider proof. |

Paths without a directory above are in `packages/engines/src`; server paths are in
`apps/server/src`. Core DTOs and existing human UI callers are unchanged.

## Corrections and caller reach

### Claude input

Previously `startTurn` removed seed history, opened native task lifetime and only
then serialized attachments. A local digest/format failure could leave no input
sent but initial history consumed and lifetime open. It now builds the complete
frame first. A required model control is preceded by validation and followed by
both a current-Run check and fresh frame validation. Seed history is removed only
after successful write. A failed transport write remains uncertain rather than
becoming a retry authorization.

`startTurn` and `steer` call the existing `RuntimeTurnInput.assertCurrent` before
submission; unsupported typed native actions are rejected rather than silently
converted into text. Fresh and retained starts already receive the callback from
`provider-run-executor.ts`. Steering was the missing caller:
`coordination-scheduler-service.ts` now captures the original session and verifies
that exact ActiveRun/session, canonical Run/fence, unexpired lease, submitted
injection, pause state and current media access. Both provider adapters recheck it
at their admission boundaries. The host still owns injection acknowledgement and
uncertain-outcome handling.

### Codex queued observations

The immediate transport observer updates the live turn ID for approval and control
handling. It can observe completion before the queued output iterator reaches
earlier events. Using that same live field for queued plan/review, token and task
receipts could discard them or misclassify usage. The output reader now advances
its own turn cursor in queue order and rejects foreign-thread or mismatched-turn
item/lifecycle events. It never rewinds live approval state. A start/review response
also cannot reinstate a turn whose completion the transport already observed.
Native background registry reads still require exact current-source item/process
receipts; missing or failed registry evidence never becomes an empty registry.

### Claude native sign-in

The previous check inferred subscription presence from `~/.claude.json` and API
presence from one environment key. That bypassed the CLI's configuration-directory,
OAuth-token, helper and precedence rules. The check now runs only the documented
read-only `claude auth status`, through the existing contained diagnostic process.
Registration and explicit availability checks pass through cancellation and
spawn-time cleanup registration. No login/logout, model request or credential
selection is added by the status read.

The status parser requires consistent exit/optional loggedIn evidence and the
native authMethod: claude.ai/oauth_token map to subscription, api_key/api_key_helper
to API. Explicit none with exit 1 is logout evidence. Unknown/inconsistent methods,
unsupported CLI versions, failed reads and timeouts remain unknown; they do not
clear retained sessions or erase work. Cleanup failures retain diagnostic failure
status so an unsettled diagnostic cannot authorize work. Raw JSON, email, key,
helper output and configuration paths are not copied into the public status.
Third-party cloud methods are not guessed into either billing category.

Primary source: [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
(`auth status`, JSON authMethod and exit contract), and
[authentication configuration](https://code.claude.com/docs/en/authentication)
(native account/configuration-directory ownership), read 2026-11-03.
The command was not executed. This research establishes its documented interface,
not the installed binary's response or entitlement.

### Claude per-task Stop declaration

The released Settings panel mounts `NativeTaskControls`, which saves an original
stop command before POST and reads its exact receipt after uncertainty. Claude's
initialize request now declares `perTaskStopAffordance:true` on the same existing
reader. The declaration was previously omitted pending that UI. In the pinned
SDK contract, its presence lets native interrupt spare background work for
individual `stop_task`; authoritative Run Stop still closes/drains the process.
It does not change a previously attached client's declaration or settle effects.
The official SDK 0.3.301 and 0.3.316 declaration byte pins and source references
are retained in [the lifetime contract](native-task-lifetimes.md).

## Exact remaining boundaries

1. **Compaction without retained native identities.** The pinned Codex/Claude
   contracts do not establish durable exact-session caller-key-to-compact-result
   lookup. The host already reserves once; another host journal, selecting the
   newest compact or submitting a marker cannot repair the missing provider
   binding. Required semantics remain in [the operation contract](native-operation-key-contract.md).
2. **Native goal continuation before work starts.** The pinned Codex extension
   can begin the next turn before exposing its identity to this host. It needs a
   restart-stable proposal/admission/revocation contract bound to the host Run and
   fence. Goal polling, forwarding active/resume, or later adopting an observed
   turn does not supply it. See [the continuation contract](codex-native-goal-continuation-boundary.md).
3. **Unreceipted original effects and native task/schedule restart gaps.** Existing
   exact host-effect receipts can be inspected without replay. They do not prove
   missing external effects, a native receipt lost before host append, or complete
   restart task/schedule discovery. Existing unknown source Runs stay held.
   Clipped cron prompts never become new work. Cross-Run schedule migration and
   per-cron deletion are not supplied by the implemented task-control contract.
4. **Provider operation limits.** Native per-task stop accepts task/process ID,
   not a conditional host fence/run/item generation. Local exact ownership checks
   cannot create atomic remote fencing or provider ID-retention promises.
   Codex PDF/audio and Claude audio remain original-file references; no unsupported
   typed wire format is invented. Older producers omitting lifecycle receipts
   remain outside the supported background-lifetime contract.
5. **Native environment and installed compatibility.** Native launch settings,
   disk hooks, configured MCP and operator login/install remain native-owned;
   this change adds no alternate TTY/login/settings subsystem. The two-mode auth
   DTO cannot represent every third-party cloud mode, and old native binaries
   without the documented status response remain unknown. This is an explicit
   limit, not an approved exception or proof of every native capability.

The named implementations above exist in source. Installed protocol/media limits,
combined approval/control/stream/lifetime behavior and whole-product qualification
remain execution questions, not claims that those implementations are absent.
No tests, fixtures, test preparation, builds, typechecks, native/browser/provider
or database execution were performed for this change.


### Owned external Git dependency application

The native import planner now maps the sanitized external dependency family into newly owned Git storage and, when bytes already match transported working files, the current owned worktree. Source paths remain inert provenance. Configured include, attribute, exclude and hook values bind to exact captured declaring-file/context records, including source-resolved named-user and installation-prefix paths. Recursive includes read only transported originals and compile into generated owned configuration. Observed missing paths remain named negative evidence; omitted paths require an already transported reviewed replacement.

Relative hooks retain distinct worktree and Git-directory contexts using declared symlink views under the reserved active-git-hooks namespace. These are inert owned aliases, not dispatch scripts. Prefix aliases used only for source path resolution are not copied as payload. Cross-scope references use typed top-Git or top-worktree contexts with closed named target evidence. Bare capsules are explicit; nonbare and linked reftable capsules use new local storage and fresh pointers. No imported ownership or source host path grants access.

Recovery writes every Git/provider byte phase before one shared native preparation, the ordinary/extended metadata staging hook and final exact native metadata pass. Completion receipts follow finalization. A service-owned deferred scope keeps finalization and ready-state custody with the service. Working-file hardlink components supply explicit named verification aliases with original root identities; unknown inode aliases remain refusal conditions. Generated hook namespace exclusion on later export additionally requires canonical local issuance authority, handled by the owning service/store and retained-original verifier.

The new pure planner regressions cover context separation, dangling symlinks with negative evidence, source-prefix alias handling, cross-scope worktree references, explicit bare capsules and omission/destination boundaries. They are registered but intentionally unexecuted until the complete implementation is integrated.
