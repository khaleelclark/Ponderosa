# Historical Codex native goals, plan, review and structured-output implementation

This report records the implementation stage at the base below. Its unavailable
and deferred statements are historical, not current command availability or test
results. The later scheduler-owned goal creation/resume path is described in
[current native goal availability](codex-native-goal-continuation-boundary.md#current-availability).
The older external-operation/recovery limits remain distinct from that path.

Source implementation at base `95448f0e52e350e306dc1d7c262e43292468a01c`.
No tests, checks, builds, types, Node, native harness or browser execution were performed in this lane. Deferred fixture source is `tests/agents/codex-native-actions.test.mjs`. Source implementation is not live parity acceptance or Bible #4 completion.

## Exact official contract

All GitHub links below are OpenAI's primary source pinned at `cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2`; installed harness compatibility is not inferred from this pin.

- [Request registration](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/common.rs) registers `thread/goal/get`, `thread/goal/set`, `thread/goal/clear`, experimental `thread/settings/update` and `review/start`.
- **The missing plan schema was retrieved:** [protocol/v2/thread.rs, ThreadSettingsUpdateParams](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L236). Its camelCase wire field is `collaborationMode: {mode: "plan" | "default", settings: {model, reasoning_effort, developer_instructions}}`. The response is an empty object, not a plan/completion receipt. `developer_instructions: null` selects the provider's built-in mode instructions. This experimental type is absent from the pinned public generated TypeScript inventory; the previous guessed TS URL's 404 is not used as a contract.
- [CollaborationMode](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/CollaborationMode.ts) and [Settings](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/Settings.ts) independently establish the nested fields.
- [TurnStartParams](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts) defines `outputSchema` as JSON Schema constraining the final assistant message for that turn.
- [ReviewStartParams](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ReviewStartParams.ts), [ReviewTarget](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ReviewTarget.ts), and [ReviewStartResponse](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ReviewStartResponse.ts) define inline delivery, typed targets, returned reviewThreadId and turn.
- [ThreadGoalSetParams](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalSetParams.ts) permits optional objective/status/origin/tokenBudget. Missing budget preserves it; null clears it. [ThreadGoal](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoal.ts) reports native status, budget, tokens/time used and timestamps.
- [Native goal processor](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L149) explicitly checks active goals because they can inject an objective or start an idle turn. The host must not issue active/resume outside a scheduler-owned continuation contract.
- [App-server documentation](https://learn.chatgpt.com/docs/app-server) supplies transport/lifecycle context. It does not establish this host's installed version or waive scheduler authority.

## Actual callable surfaces

| Human surface | Native operation and disposition |
| --- | --- |
| `/goal` | Existing human `POST /api/agents/:id/provider-commands`, name `goal`; `thread/goal/get` for exact live accepted session. Typed `goal` DTO and bounded human notice retain native objective/status/budget/usage/time. Null remains no goal. |
| `/goal-edit {"objective":"Explicit objective","tokenBudget":10000}` | Same endpoint name `goal-edit`; closed JSON permits only objective and/or budget. Emits `thread/goal/set` with `origin:"user",status:"paused"`. Missing budget stays missing; explicit null clears; positive safe integer accepted. Never creates an active objective. |
| `/goal-pause` | `thread/goal/set` with explicit user origin and paused status. Response must confirm paused snapshot. |
| `/goal-clear` | `thread/goal/clear` with user origin; exact native cleared boolean returned. No automatic retry. |
| `/goal-resume` | Discoverable **unavailable**, with explicit scheduler-continuation reason. Native active/default-active creation and automatic continuation remain an implementation gap. |
| `/plan {"prompt":"Inspect the design","mode":"plan"}` | Prompt command enters canonical human intake and scheduler Run; after native harness/current-Run checks, sends `thread/settings/update` with exact selected model/effort and built-in mode instructions, then the same accepted full text packet to `turn/start`. Mode `default` restores ordinary native mode. The prompt remains visibly present inside the canonical JSON command; it is not silently substituted for recorded context. |
| `/review {"type":"uncommittedChanges"}` | Canonical human command enters scheduler Run; dispatches `review/start` on accepted retained session, inline, and validates returned thread/turn. Also supports baseBranch/branch, commit/sha/optional title, custom/instructions. No fresh detached review thread or idle native turn. |
| `/structured {"prompt":"Return an answer","schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}}` | Canonical human command enters scheduler Run; sends exact schema through `turn/start.outputSchema`. Existing normal final-response path remains; provider enforces the schema. No claim of local schema validity beyond bounded JSON object/nesting. |

The existing slash discovery/composer supplies these actions, arguments and disabled reasons. Agent-authored prose, historical quoted commands and revised display text do not choose native actions. Dispatch reparses only the exact immutable canonical **human** Communication selected for this Run. No goal tools are added to the Agent tool catalog. Native action admission uses the Adapter support descriptor, not provider-specific branches in server/UI.

Native plan/review/schema actions always select next-Run delivery at intake, including when the Agent is currently idle, so an admission race cannot turn structured work into steering. The existing human intake/scheduler, provider selection/restrictions, cancellation and event fences still own work. The executor supplies an exact current-Run callback; Codex rechecks it before and after asynchronous native harness admission and after plan-settings acknowledgement. Existing native tools remain restriction-bound. No sandbox, approval, cwd, credentials, arbitrary developer instructions or arbitrary RPC method can be supplied through these command JSON bodies.

The accepted input source manifest stores the exact native action. For review, provider_prompt records the serialized actual `review/start` method/parameters rather than falsely recording the assembled text packet as submitted text. Review uses retained native context and current trusted instructions; it does not inject the assembled history as a new user message. Native action failures do not take the old fresh-session fallback, which could replay a review mutation. Lost review/turn acknowledgements still have the existing uncertain-outcome handling; no provider operation-key lookup is invented.

Goal commands require a **live accepted** session whose saved identity, tool contract and current human restrictions agree. They do not cold-open/resume a native session: resuming a pre-existing active goal can itself begin autonomous work. Goal mutations return outcome_unknown after a lost/malformed response and instruct inspection rather than retry. Goal activation/continuation has no hidden native loop or new host wake source in this change.

## Structured execution projections

Matching-thread/current-turn `turn/plan/updated` becomes `native_plan` with explanation and individually typed steps/statuses; `turn/diff/updated` becomes `native_diff`; native entered/exited review items become `native_review` lifecycle receipts. All pass closed descriptor-safe AgentEvent projection, canonical event persistence, activity projection and refresh-safe UI notice rows. They never become authored Chat or a successful host Request result. Provider-native plan completion is not the host's task completion, and a review entry is not a successful review exit.

## Precise remaining implementation and verification

1. **G2 is partial:** active/resume/default-active goal creation and automatic continuation remain unimplemented because native idle turns lack host scheduler Run/lease/fence ownership. A future implementation must durably bind each native continuation, stop/pause, budget-limit and recovery to scheduler ownership; merely forwarding active or polling does not solve that boundary. Native goal automatic tools/configuration already inherited by a harness are not requalified by this lane. Cold goal inspection remains unavailable to avoid triggering a resume continuation.
2. **G3 source paths added, not live verified:** experimental plan availability, installed-version target/schema support, model-mode settings persistence, schema enforcement, review completion and all refresh/UI rendering need later whole-implementation execution. Provider rejection is surfaced, not converted to success. No schema model compatibility is inferred.
3. Successor command intake covers individual Agent, Conversation Broadcast and explicit multi-recipient direct messages. See `codex-native-goal-continuation-boundary.md` for canonical source selection, coalescing, artifact bounds and the exact external continuation block. No broad live parity claim.
4. Review has an accepted retained-session requirement. Its provider protocol has no client operation key in this pin, so lost acknowledgement recovery is not solved by this lane. The previously documented M2 seam remains.
5. Source-only fixtures cover goal origin/paused editing/budget/null behavior, no mutation replay, closed native command syntax, exact review thread matching, actual plan-settings wire acknowledgement, plan/diff structured projection and rejection of premature review completion. They have not run. Whole build/type/native/browser validation and broader scheduler/UI integration remain deferred by instruction.

No Bible edits, tests/checks/build/types/Node/native/browser runs, installs, new workers, push, merge or deployment.
