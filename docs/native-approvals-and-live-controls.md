# Native approval callbacks and retained Claude controls

Source implementation for U1 G1/G4, integrated from `bf54bc0e163e4a405e52eb47550e3785d69638d2` after current M4/Codex/G7 source. Shared adapters and provider dispatch compose those existing lanes. This is not execution qualification or whole harness
parity acceptance. No native process, SDK, Node, tests, builds or typechecks were
executed for this change.

## Human approval reaches the original native callback

The existing operator Decision form UI and live elicitation broker now carry
`RuntimeNativeApprovalIdentity`: exact transport request, provider session,
current native turn and operation kind. `native-approvals.ts` requires an explicit
human `approve:true` field and `action:accept`; submitting an empty form, ordinary
prose, a generic confirmation, refusal, cancellation and another response cannot
approve. Native forms cannot inherit or create the broker's remembered run-wide
confirmation grants. They resolve one waiting callback only, never session grants or
saved policy amendments. Codex permission grants have the explicit native `turn`
scope, shown in the human checkbox/context; command/file/tool approvals are once. Requests with more than 32,000 JSON characters are
refused in full, not silently truncated; this bounds the existing form UI and
review surface.

`provider-run-executor.ts` resolves the current Run rather than the Run that
opened the retained process. Before creating the Decision and again after the
wait/audit await, it requires the same runtime identity, live owned Run/fence,
uncancelled signal and exact native provider session. Native cancellation joins
the Run signal to the live broker wait, cancels the pending Decision and prevents
late consent from authorizing anything. Payload-free native request identity and
human consent/refusal are recorded as Work log tool events; native inputs/form
content remain ephemeral in the existing broker. Neither events nor provider
output become authored Chat or subsequent canonical input.

### Codex

The owned `handleServerRequest` now dispatches:

- `item/commandExecution/requestApproval` -> original RPC `{decision:accept|decline}`;
- `item/fileChange/requestApproval` -> original RPC `{decision:accept|decline}`;
- `item/permissions/requestApproval` -> original RPC `{permissions,scope:turn}`,
  containing only the exact requested network/fileSystem fields when approved,
  or an empty permissions object on refusal.

All require exact thread, active native turn, item and fresh request identity.
Native turn completion, serverRequest/resolved and root exit cancel waiting consent.
Turn identity is captured by the existing notification reader even before the
ordinary event consumer advances; it is checked again after the human wait.
With a human callback, retained session start/resume use `on-request` approval
policy. Without a callback, they retain `never`; discovery remains unchanged.
No tool is rerun, no exec/network rule amended and no session-wide grant emitted.
The existing deny-only host write/connector restrictions refuse matching escalation:
write-restricted command/file callbacks and requested filesystem permission grants
are denied, as are restricted Claude shell/editor tools and exact connector tool
prefixes. Unrelated native requests remain usable. Explicit human write restrictions
also disallow PowerShell alongside Bash; neither shell is represented as read-only.

### Claude

When the host human callback exists, launch adds the official
`--permission-prompt-tool stdio` option. `can_use_tool` goes through the same human
Decision path and returns the original `request_id` success control response with
`behavior:allow` and the exact original `updatedInput`, or `behavior:deny`.
No input or permission rule is rewritten. `control_cancel_request`, interruption,
turn completion and process close settle/cancel pending waits without grants.
Unsupported unregistered SDK hook/MCP callbacks return a control error; disk
hooks and configured native MCP continue through their existing native paths.
Duplicate request identities are never granted twice. Native requests run
asynchronously so their human waits do not block the single stdout reader.

The existing operator-configured/default Claude permission mode is preserved,
including the existing `bypassPermissions` default. Adding callbacks does not
silently lower human access. Native prompts appear when the human selects a mode
whose native rules require them. Existing AskUserQuestion replacement remains a
separate question domain; generic questions do not impersonate native approvals.

## Claude live controls

`ClaudeControls` sends correlated official control frames on the existing owned
transport. One stdout reader matches their exact request IDs; no second consumer,
prose-success inference, HTTP provider call or new engine is introduced.

- `session.interrupt()` sends `{subtype:interrupt}` and awaits its own success
  response without destroying the retained process. Authoritative Stop/deletion
  still fences the Run and calls `close()` for observed process-group drain.
  An interrupt ack never proves process exit or source effect completion.
- `session.invokeCommand('native-model', model)` sends `set_model` at an idle boundary.
  The next ordinary `startTurn` also applies a changed typed model with this
  control before input. Unsupported effort changes refuse visibly and require
  reopening the same retained session; no effort value is silently ignored.
- `session.invokeCommand('native-permission-mode', mode)` sends `set_permission_mode`
  for human-selected `default`, `acceptEdits`, `plan`, `dontAsk`,
  `bypassPermissions` or `auto`. Saved deny-only tool restrictions remain in the
  native launch configuration. Provider rejection remains visible.
- `session.invokeCommand('native-context-usage')` sends separate `get_context_usage` and
  validates actual totalTokens/rawMaxTokens/model before returning a
  session-bound occupancy. It does not accept source work or write a fabricated
  recovery receipt.

Ten-second control deadlines bound the request wait; timeout or transport loss
marks the session control state uncertain and prevents normal input/control
replay. Close rejects pending controls. Explicit protocol errors reject visibly.
Optional foreign session identity rejects the response. Sixteen pending controls,
32 waiting native approvals and 10,000 consumed native request identities bound
per-process state; exhaustion refuses/closes rather than evicting receipts and
allowing replay. These are transport/resource limits, not stored access changes.
No current compact completion or original uncertain Run is reconciled by these
controls. Existing Codex known-ID fallback and Claude native compact protocol are
preserved. A model control invalidates local occupancy and old model init evidence;
compaction requires fresh actual provider init rather than fabricated metadata.

## Operator endpoint and UI

`GET /api/agents/:id/native-controls` returns the current retained session,
source Run/fence and supported model/permission operations.
`POST` accepts `NativeRuntimeControlRequest` with that exact boundary, operation
and value. The route checks before and after asynchronous capabilities/native
acknowledgement, refuses held recovery/deletion/stale lease/fence/runtime and
never opens a new Run or process. Human model changes must agree with the Agent's
saved model setting. It records native control Work log/audit events and never
settles source Run/Request effects. A late acknowledgement after authority changes
returns `outcome_unknown` without replay. Control audit work conservatively
invalidates a preceding completed source context estimate; normal Context Refresh
may be needed before the next idle context command.

Live-control inspection and changes capture the retained session object and native
session ID along with the runtime, source Run and fence. After capability discovery,
GET refuses a changed boundary instead of returning stale controls. POST checks the
same captured boundary before sending and after acknowledgement. The saved human
model choice is reread after capability discovery, immediately before sending. Replacing a session
on a retained runtime cannot redirect an earlier settings request. If ownership changes
after sending, the result stays unknown and the route does not retry the command.

Generic transient provider-command endpoints refuse model/permission-mode changes
and direct the operator to retained Agent Settings, preventing apparent controls
that disappear when a temporary helper exits.

Agent Settings exposes Load Current Controls, Apply Saved Model and explicit
native permission mode selection using the same MUI/form patterns. The endpoint is absent from managed
Agent tool schemas; provider callbacks never invoke it as an automatic access
change. The host retains its existing full local-user shell authority. Existing global operator
Origin/HTTP conventions apply; no operator token or credential store was added.
The controls apply to the current process; permission mode is not a new portable
Agent setting and reopens use the existing operator-configured native mode.

## Pinned protocol evidence

- [Codex server request names](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/common.rs).
- [Command approval response](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionApprovalDecision.ts),
  [file approval response](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/FileChangeApprovalDecision.ts),
  [permission response and scope](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/PermissionsRequestApprovalResponse.ts).
- [Claude pinned Python query control handling and live methods](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/query.py),
  [permission stdio configuration and supported modes](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/types.py),
  [actual native transport flags](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/transport/subprocess_cli.py).

Read-only official raw source retrieval only; no SDK installation/execution.
Installed-version support, native callback/UI execution and whole-flow behavior
remain unqualified. Deferred fixtures cover actual original-callback response
shapes, refusal/cancellation/replay/stale-turn handling, control correlation and
human route session/fence checks. They were written, not run.

## Remaining and domain boundaries

G1/G4 now have callable source implementations, not universal parity verdicts.
Persistent per-Agent permission mode/launch settings, native hook registration and
path-level filesystem escalation under an existing deny-only write policy are not introduced.
M2 durable lost-ack/noIDs result lookup and M3 original uncertain effect
reconciliation remain distinct work; no native source effects are inferred or
replayed. G2 live-session paused goal controls and G3 individual-Agent human plan/review/schema actions are assembled, with active goal continuation and broader intake still open. G7 bounded console/recording tools/API/SDK are assembled; operator UI scope remains unresolved. G5 file rewind/fork, G6 modality and G8 pending native task lifetime remain pending assignment and unqualified. Native TaskOutput was removed upstream; inherited output-file
Read is its domain disposition, not a request to resurrect a removed tool.
Operator-native installation/login/TTY rendering remain documented domain
boundaries, never an approved blanket exception to Bible #4. No whole-work done
claim follows from this source implementation.
