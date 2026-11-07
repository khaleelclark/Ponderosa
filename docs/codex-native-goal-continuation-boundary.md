# Codex native goal availability and historical continuation boundary

## Current availability

Source checked at `a4e6906499fc67e5e0c35a77d422d2288dceff03`: canonical human
`/goal-create` and `/goal-resume` are supported prompt actions admitted through the
scheduler. They are not runtime commands or text-only steers. Creation validates
that no goal exists, plus the bounded objective and optional positive/null budget;
resume requires the exact paused goal and this Agent’s accepted retained session.
Both reject attachments and coalesced source bundles.

The executor dispatches `startNativeGoal` only on the qualified built-in Codex
session owned by the current Run. The session checks current authority before and
after activation; a lost or malformed activation result stays unknown and is not
repeated. The standalone `invokeCodexGoal('goal-resume')` helper still refuses:
that helper is not the canonical scheduler-owned prompt-action path.

This implemented campaign path supersedes the blanket unavailable statements in
the historical notes below. It does not add an external per-continuation lease
RPC, durable original-operation lookup, or permission to replay uncertain work.
Source availability is not universal installed-provider or parity qualification.
Direct source: `native-goal-command-availability.ts`, `codex-native-actions.ts`,
`CodexAppServerSession.startNativeGoal`, and `routes/provider-run-executor.ts`.

## Historical implementation notes

Parent implementation: `f1ba5e152f8fa24d41d5fc8bfd89af673c8770ea`, isolated writer branch `phase2/codex-native-goals-plan`, checkout `/tmp/ponderosa-codex-goals-plan`. This successor changes server source, docs and deferred fixture source only. No web writes or execution validation.

### Native continuation: external contract investigated at the parent pin

Primary source is OpenAI Codex pinned `cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2`. These are source contracts, not installed-version evidence:

- [thread_goal_processor.rs](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L149): omitted new status defaults to active; the set handler sends its response before applying runtime effects at the end of `thread_goal_set_inner`. A successful set receipt cannot certify ownership of the resulting turns.
- [ext/goal/src/runtime.rs](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/ext/goal/src/runtime.rs#L175): `apply_external_goal_set` handles active status and calls `continue_if_idle`. Lines 436–500 read active goal state and directly call `thread.start_turn_if_idle`; continuation identity is recorded only after `Started` returns.
- [ext/goal/src/extension.rs](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/ext/goal/src/extension.rs#L165): resume restores goal runtime state; idle lifecycle calls `continue_if_idle` again. Reserving one host Run around goal/set does not own each following turn.
- [app-server protocol common.rs](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/common.rs#L631): public goal requests are get/set/clear; notifications are updated/cleared. No request grants a caller-controlled, pre-start continuation lease or binds each next goal turn to a host operation identity. The runtime's internal state-DB continuation deferral is not an app-server RPC contract. Ponderosa must not edit provider state databases to simulate such a contract.

Minimum missing external contract: each goal continuation must be proposed before native work starts and remain durably deferred until a host admission explicitly binds the exact continuation identity to the current Run/fence. Revocation, pause/stop, budget exhaustion and restart recovery must prevent a deferred or revoked continuation from starting; inspection must identify accepted/started/finished or uncertain operations without replay. This is a required behavior, not a guessed RPC name or claim that a provider currently implements it.

Accordingly `/goal-resume`, native active creation/default-active goal editing and autonomous native continuation remain unavailable. This successor adds no polling loop, fake host journal, process notification adoption, automatic retry or speculative goal activation. Host Run cancellation/pause does not by itself prove native persisted goal suspension. Existing `/goal-edit` always explicitly pauses and validates budget; `/goal-pause`, `/goal-clear` and `/goal` keep their accepted-live-idle-session limits and uncertain mutation outcomes. Active-run native pause/stop/clear, budget mutation during native active work, per-continuation cancellation and continuation recovery are NOT implemented. Generic exact host cancellation remains available, but must not be reported as that missing native contract. No goals are silently created.

## Usable command intake behavior

Conversation Broadcast keeps its existing explicit recipient routing; a native command activates only actual leased recipients, never everyone who inherits shared context. Multi-recipient direct commands use their existing stable explicit recipient IDs. Different recipients independently receive the exact same canonical human command and retain their provider/session restrictions; an unsupported recipient fails loudly before a native action is submitted. There is no routing inferred from command prose or rendered mentions.

Both Conversation intake routes parse the human body before long-text staging and force native actions to `next_run`, including when a client requests steering. The individual Agent path retains the same rule. The queued-message steer endpoint refuses a canonical native command, including one stored as a document, so it cannot be downgraded into a text-only steer.

At actual dispatch `native-command-selection.ts` reads all Communication IDs from the exact prepared injection's attached activation payloads, then rereads immutable canonical events from the project store. It requires user authorship and actual recipient/scope agreement. Historical context, agent prose, compiled prompt text, queue display revisions and quoted commands cannot select an operation. Duplicate appearances of one source ID count once. Missing canonical records or document bodies fail closed.

Artifact-backed commands use `authoritativeCommunicationDocument`, which already validates author, artifact metadata and project access before returning full content. The helper requires the returned event to match the exact source event. It parses that full body, never the clipped summary. Existing native argument limit (64,000 characters), prompt/objective bounds and schema depth limits remain. Oversized/invalid commands return an explicit error; an artifact does not bypass limits or confer authority.

One native plan or structured-output action can accompany ordinary leased sources: the normal full accepted provider packet remains submitted. Two distinct native actions in one injection fail with HTTP 422 before preparation/provider submission; no arbitrary first/last command selection occurs. Native review dispatch submits its native retained-context RPC rather than a new assembled prompt, so any coalesced review bundle is rejected with HTTP 422 to avoid silently consuming other sources. The scheduler's existing nonretryable dispatch-failure disposition owns those deliveries; the operator must submit commands in separate Runs after resolving the failed delivery. This successor does not split one durable injection into invented extra Runs.

## UI and integration contract

No new UI files, DTOs or activity events. Existing canonical delivery failure exposes HTTP 422 error text; existing provider-command result and native activity projections remain the parent contract. Do not mark a failed coalesced command successful or automatically retry it. The UI may offer the existing separate-message workflow, but cannot claim active native continuation support.

Additive wiring: `authoritativeCommunicationDocument` is forwarded through `application-routes.ts` to message-run and queued-message routes. New helper has no storage or authority of its own. These hunks must compose with Runtime G1/G4, G8, typed inputs and integration-owned UI changes; no writes occurred in their worktrees.

Deferred source fixture: `tests/agents/codex-native-command-selection.test.mjs`. It covers canonical selection after a nonhuman source, duplicate identity, explicit multi-recipient addressing, foreign scope exclusion, multiple-command rejection, full-document selection, missing-record/body failure and ordinary-prose nonselection. No tests, typecheck, build, Node, native harness, browser, service, install or deployment were run. Route wiring, queued steer refusal, permanent delivery failures, installed provider behavior and whole-implementation validation remain unexecuted.
