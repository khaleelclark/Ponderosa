# Codex Phase 2 runtime completion — 3 November 2026

Source base: `7a7504b0b25a79f72ab00cbc991a043606526467`.
Owner: Codex `/root/runtime`, isolated branch
`codex/phase2-runtime-20261103`.
Authoritative Bible: the complete 530-line Library file, SHA-256
`ac314d93732e631bb042b8d3d2dc802ba08446812f99ba931023d2e02b14ab58`.
This records source implementation. Tests and builds are deferred until every
implementation lane is integrated, following Patrick's later instruction.

| Requirement | Source change / disposition |
| --- | --- |
| #4/#11 Native human questions | Codex `item/tool/requestUserInput` and Claude `AskUserQuestion` use the existing human form/Decision/broker path. The adapter translates original questions and responses; no model retry through another tool is needed. Claude no longer removes its question tool from every session. |
| #6/#13 Exact human authority | Each callback retains its original request/session/turn and cancellation signal. Duplicate or foreign identities refuse; completed/replaced turns cannot accept late answers. Questions have a distinct identity kind, never a permission grant or remembered confirmation. Codex nonblocking intent reaches the existing Decision's blocking flag. |
| #3/#4 Native form capabilities | Shared form fields offer native choices with free-text alternatives, multiple selections and masked secret input. Answers go straight to the live callback and are not saved in Ponderosa; durable audit records only that the human answered/declined. Claude receives its unchanged original input plus answer strings; Codex receives answers under the original question IDs. |
| #12/#14 Native control causes | Correlated Claude rejection causes survive adapter handling. The operator route records and returns the existing shared-redactor output instead of discarding the cause. No mutation retry or process-exit claim is introduced. |
| #14/#25 Native diagnostics | Direct Codex availability checks pass cancellation/spawn ownership to the prerequisite auth command. Both provider availability paths refuse a new model request after unconfirmed auth-process cleanup or cancellation. Diagnostic collectors stop retaining output once finishing starts. |
| #25 Truthful login mode | Codex subscription status accepts a complete known native status line, rather than error prose containing “ChatGPT” and “logged in.” Claude remains selected by the native status command, not inferred from environment keys. Existing fixtures now model the native command and do not invoke an installed provider account. |

The native-question transport has a 32-question / 32,000-byte normalized-form
bound and 100 options per question to protect synchronous form/transport memory;
it refuses explicitly and never clips questions. Other future SDK callback
methods remain explicit unsupported errors. HTML option previews are not rendered
by this text form, and these source changes do not establish every-version native
parity or comparative UI acceptance.

Primary protocol sources checked:

- [Pinned Codex question parameters](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputParams.ts),
  [question fields](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputQuestion.ts),
  [answer shape](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputAnswer.ts).
- [Claude official SDK user-input contract](https://code.claude.com/docs/en/agent-sdk/user-input),
  read 3 November 2026, plus its existing pinned stdio control transport listed in
  [native approvals](native-approvals-and-live-controls.md).

## Genuine remaining runtime boundaries

1. `verifyRetainedFinalExitCommand` still refuses portable final-resource proof.
   Native capture/readback verifies independent original SQL inventories; portable
   owner/fact hashes can be recomputed after omitting an unknown start or effect.
   There is no existing independently authenticated portable completeness carrier
   covering all original starts, effects, creation/members, selected/latest
   frontiers and pins. Another nested hash or human permission cannot establish
   those missing historical facts. This is an unresolved provenance contract,
   not authority to replay effects, silently omit data, or claim continuation.
2. Lost native compaction identity lacks exact caller-key/result lookup; active
   native goal continuation lacks pre-start scheduler admission; native task and
   schedule restart lack complete original-effect discovery/fencing contracts.
   These are retained [native protocol boundaries](native-harness-reconciliation.md),
   not source booleans to bypass.
3. Provider-installed compatibility, historical receipt availability, comparison
   judging, native pending-work restart semantics, UI recordings and whole Bible
   acceptance require consolidated validation. None is claimed passed here.

Deferred runnable regressions are in the existing provider-access,
native-approval-controls, native-control-routes and capability-restrictions files.
They cover native choice/free text/multi-select/secret metadata, exact original
input, cancellation/stale turn/duplicate/foreign refusal, known control cause
redaction, status truthfulness, cleanup holds and probe cancellation/ownership.
No deployment, restart, live database mutation or external effect replay occurred.

