# Chat input inventory and multiline paste qualification

This inventory follows rendered callers, including conditional fields. It does
not equate one shared component test with every caller being exercised.
`chat-input-census.mjs` parses every web TSX input declaration with TypeScript and
writes `ui-chat-input-census.json`: 135 declarations, 11 chat input/editor
declarations and 124 explicit exclusions. Main editor wrappers are included;
they are not eleven independent text widgets.

Reproduce the source census from the repository root:

```sh
node tests/workspace-navigation/chat-input-census.mjs
```

| Input | Rendered callers | Regression kinds |
|---|---|---|
| Main Lexical editor | Core shared Chat, Branches shared Chat, individual Agent Chat, Inbox, actual `/assistant`, designated `/apps/:id` | Original rapid suite plus `dm`, `inbox` |
| Long pasted-text editor | `View or edit` dialog opened after a real paste above the inline threshold; inherited by all four products | `long-edit` |
| Queued-message editor | Agent Chat in all four products; shared Chat in Core/Branches; selected Inbox source | `queue`, `queue-chat`, `queue-inbox` |
| Typed call turn | Expanded `Transcript & typing`: Agent Chat in all four products, shared Chat in Core/Branches, selected Inbox source | `call`, `call-chat`, `call-inbox` |
| Initial Agent message | Core create page and Branches/standalone embedded creation dialog, including delegated creation | `initial` |
| Decision answer | Agent timeline in all four products; shared Chat timeline; Inbox timeline; notification drawer; Branches execution actions | `decision-text`, `decision-chat`, `decision-inbox`, `decision-notification`, `decision-execution` |
| Choice/approval alternative | `Something Else` in the shared Decision dialog | `decision-other`, `decision-approval` |
| Grouped answers | Every question in a three-question Decision, including a choice's alternative text; Next preserves previous answers | `decision-group` |
| Provider-request alternative | `Other` → `Tell the Agent what you want instead`, for both form and URL requests | `runtime-other`, `runtime-url-other` |

Standalone routes inherit Agent Chat through `OutputAgentApp` → `BranchChats` →
`AgentDetailComposer`; shared Chat is not assumed to be the same route. The
standalone header does not expose the global notification drawer or Inbox.
`NewChatComposer` opens a saved empty Chat and has no message text input.

## Oracle and evidence

The focused harness uses real built development assets, a disposable real API,
controlled providers and the already-installed Docker WebKitGTK image with
`--pull=never`. It installs nothing and does not deploy or mutate a live dev or
production instance. WebKitGTK MiniBrowser is not Safari or iOS.

Each conditional field receives actual GTK clipboard LF and CRLF payloads with
Unicode, a second line, an empty line and an exact tail. Both deliveries are
checked against the complete draft and the trusted browser paste event. The last
(CRLF) delivery is submitted; WebKit normalizes its line endings to LF before the
application listener. Raw CRLF retention is not claimed. The original rapid
suite separately submits both LF and CRLF cases on the four main routes.

`verify-chat-input-evidence.mjs` checks complete accepted request bodies and
canonical messages, Decision responses or queue snapshots, with exact stable
recipient IDs. It does not strip mentions or truncate/trim bodies. Inbox requests
include the deliberately selected recipient token; ordinary private Chat
requests omit it. Top-level initial tasks retain their canonical `#broadcast` prefix; delegated
initial tasks retain their collaboration scope without that prefix. Both target
only the new Agent. Typed calls use structured recipients and canonical
body text without a rendered mention prefix. These are distinct source formats.

Queue fixture input uses the caller's actual API: Agent message queue for Agent
Chat and conversation direct-message queue for shared Chat/Inbox. It captures
canonical queue snapshots before releasing controlled held Runs. Runtime provider
requests use the real elicitation callback. No microphone, speech recognition,
external connection link, provider account or paid inference is used.

Examples:

```sh
QUALIFICATION_PRODUCTS=core,branches,assistant,output \
QUALIFICATION_DIRECTORY=/tmp/ponderosa-input-evidence \
node --import ./tests/shared/workspace-resolution.mjs \
  tests/workspace-navigation/webkit-every-input.mjs

node tests/workspace-navigation/verify-chat-input-evidence.mjs \
  /tmp/ponderosa-input-evidence
```

`QUALIFICATION_PRODUCTS`, `QUALIFICATION_THEMES` and `QUALIFICATION_KINDS` select
focused reruns. The harness fails on the first failed row and retains raw events,
requests, canonical snapshots, screenshots, page text/HTML and its source copies.
Failed selector/oracle/setup runs remain evidence, not passes. Build before tests;
do not build while a qualification is reading the asset directory.

## Explicit boundaries

The machine census lists every other declared input and why it is separate:
settings/instructions, search/filter, navigation and file selectors, workflow
Run/gate/intervention values, imported JSON and read-only previews. The remote
browser's desktop/mobile keyboard textareas send input to a website rather than
a Ponderosa Communication. Structured provider schema fields send values to the
provider and deliberately do not persist those values as Chat. Their single-line
string fields are not qualified for multiline retention by this suite; this is
an explicit untested adjacent surface, not an all-text-input passing claim.

Representative conditional fields do not qualify every possible combination of
attachments, retry/offline/reload, oversized text, edge whitespace, runtime
permission/consent state, speech transcript, phone keyboard or viewport. Physical
Safari/iOS, screen-reader checks and final integrated-candidate proof remain
separate gates. Observer #27 remains a recorded defect class: desktop resize
control missing its value and invalid mobile tab structure. Source fixes alone
are not final integrated accessibility proof. Original findings remain at
`/tmp/ponderosa-audit-ui/a11y27-text29/report.md` and the observer addendum.

Exact executed cells, remaining cells, source commit, commands and results belong
in the accompanying qualification report. This document is an inventory and
reproducible test entry point, not a whole-UI or release-completion verdict.

## Bounded executed result

The isolated development build qualified 114 caller/theme cells and 130 complete
submitted/canonical authored bodies. The three-question cases account for the
extra bodies. All 260 measured native field pastes were trusted: 130 LF payloads
arrived unchanged and 130 CRLF payloads were delivered as LF before the application
listener. No raw CRLF equality is claimed. There are 114 corresponding screenshots
with full HTML/text captures.

| Product | Light caller cells | Dark caller cells | Result |
|---|---:|---:|---|
| Core | 19 | 19 | Pass |
| Branches | 16 | 16 | Pass |
| Assistant | 11 | 11 | Pass |
| Designated output | 11 | 11 | Pass |

This aggregates separately retained runs. Core's two successful rows come from an
invocation that later stopped on a Branches notification selector; its original
nonzero exit remains preserved, and the Core complete-body oracle passes offline.
Branches notifications pass in a focused invocation, and the six remaining
product/theme rows pass in a separate invocation. It is not one clean combined
invocation. Exact run provenance and every selected case are recorded in the
accompanying report and `matrix-result.json` evidence.

Application sources are identical to the frozen rapid-paste candidate
`f250d60cf0105c0287008f2588bbce26bd6b59fd`. Review/integration and the boundaries
above remain open; this does not close the broader EVERY-input or #27 release
requirements on the final integrated candidate.
