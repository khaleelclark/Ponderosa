# Phase 2 current source checklist — 4 November 2026

Owner: Codex integration. This is a source reconciliation, not a final audit
verdict or deployment. Authoritative Behavior Bible 2: 530 lines, SHA-256
`ac314d93732e631bb042b8d3d2dc802ba08446812f99ba931023d2e02b14ab58`.
Later user direction assigns this work to Codex and calls for implementation
before consolidated final testing. Mobile emulation is acceptable; human-only
checks do not block independent implementation. The Bible itself is unchanged.

“Mechanism present” means a relevant current implementation was found; it is
not proof that every case works or a True verdict. “Missing/held” identifies a
known implementation gap. “Qualification open” means required execution,
measurement or judging remains. Per the Bible, a verdict without evidence is
not True. The older reconciliation and exact historical results remain in
`codex-phase2-reconciliation-20261103.md` and `codex-phase2-build-20261103.md`.

| # | Owner | Current source status and remaining work |
|---|---|---|
| 1 | Continuation | **Missing/held:** canonical history remains stored, but voice-memory, scope and tool-contract changes can reseed bounded provider context outside a managed handoff. See `context-reconstruction-boundaries.md`; a safe compliant handoff must also respect memory permissions. |
| 2 | Integration | Mechanisms and run-input records exist; a complete context/access/behavior inventory, documentation and no-shadow-path audit remain open. |
| 3 | Interface | Shared desktop/mobile surfaces exist; complete nontechnical walkthrough, comparison and blind judging remain open. |
| 4 | Runtime | **Missing/held:** native goal pre-start admission and no-identity compaction recovery are not established; native capabilities and provider parity need full qualification. See `native-harness-reconciliation.md`. |
| 5 | Integration | Existing limits and optional integrations have identified purposes; complete dependency and rule census remains open. No mandatory Tailscale dependency was found in the scoped review. |
| 6 | Runtime + memory | Human capability policy and reviewed imports exist. Full grant-change trace remains open; uncertain memory scopes and cleanup are held rather than silently recreated. |
| 7 | Integration | No operator-token requirement was found in inspected core admission; browser Origin checks and Agent capability scope remain. Complete authentication census remains open. |
| 8 | Portability | **Missing/held:** reviewed export/import and substantial native/Git restoration exist, but some cross-root links, ownership layouts, native platforms and portable final-resource continuation remain held or unqualified. A complete fresh-install identical round trip remains open. |
| 9 | Integration | Shared canonical mechanisms exist; exhaustive dead-code, duplication and near-duplicate review remains open. |
| 10 | Runtime | Public Branches client exists. A separate sample process passed Script workflow start, idempotent replay, status and result against an earlier synthetic server; current-server and broader outside-app qualification remain open. |
| 11 | Coordination | Concise agent communication and artifact references are instructed. Real-log blind judging, overhead comparison and reliable avoidance of provider-generated loops remain open. |
| 12 | Continuation | Durable recovery and visible holds exist; crash/restart and all truncation paths need full qualification. Unknown effects are not silently replayed. |
| 13 | Coordination | Tracked Requests and actionable peer messages steer; marked progress/FYI remains visible and noninterrupting. A practical host prompt fence rejects controlled stale calls, not proof of provider comprehension. Reviewed continuation covers qualified persistent Codex and Claude paths with exact evidence; unsupported/multiple/unknown cases remain held. Live-provider, full Stop/pause/redirect and no-loop verification remain open. |
| 14 | Runtime | Visible failure/hold reporting exists. **Missing/held:** general stuck-work detection and complete exact-cause visibility are not established; provider-outage/rate-limit/stuck-work qualification remains open. |
| 15 | Portability + memory | User-folder custody protections and pending-cleanup reporting exist. Internal populated Chroma cleanup and staged rollback source changes are integrated through `e0a9414e9`; behavioral validation remains open, including the 12 historical server cases. Unknown effects remain held. |
| 16 | Runtime | Trigger occurrence identity, catch-up and logging exist; all timing, clock-change and reason-trail acceptance remains open. |
| 17 | Integration | A controlled populated upgrade and focused regressions passed; the final whole suite, crash qualification and 20 consecutive controlled core-path runs remain open. |
| 18 | Interface | Notification settings and grouped browser displays exist; controlled bursts were checked. Actual push/OS behavior, all settings and mention semantics remain unqualified. |
| 19 | Integration | Activity and audit records exist. **Missing/held:** unexpected Branch deletion errors can be withheld rather than giving the complete real cause because a general exact-secret-value redactor is unavailable. Ten UI trails and plain-language judging remain open. |
| 20 | Integration | Origin checks and normal browser safeguards remain. Patrick clarified that the network-security rule concerns attacks by someone on the same network, not ordinary browser, internet-facing or malicious-web-content protections; the generic-header-removal draft must not be integrated. No operator-token gate was found in inspected core admission. Complete network-specific and authentication census remains open. |
| 21 | Interface | Streaming and bounded rendering exist; the Bible's 10,000-message/20-active-Agent, desktop/mobile Event Timing measurements remain open. |
| 22 | Integration | Installer, bootstrap and docs exist; the fresh docs-only install-to-first-reply timing remains open. |
| 23 | Integration | Current guidance exists and a stale peer-steering instruction was corrected. Exhaustive documented-behavior execution and documentation reconciliation remain open. |
| 24 | Interface | The usage screen now treats incomplete component totals as unavailable and displays exact token counts, duration and coverage; full UI metric census remains open. API partial sums require `metricAvailability`. |
| 25 | Runtime | Native subscription/API detection and switching mechanisms exist without a mandatory picker; real-account mode switching, capability parity and state preservation remain unqualified. |
| 26 | Interface | Shared components exist; a complete common-action/component inventory and visual judgment remain open. |
| 27 | Interface | Theme and text-size controls exist; keyboard, screen reader, contrast, zoom and automated accessibility qualification remain open. |
| 28 | Integration | Branches uses shared Core paths, but every Bible requirement must separately be qualified for Branches; aggregate parity remains open. |
| 29 | Interface | Folders and shared Output/chat UI exist. Full copy census, screenshots, recordings and blind comparison remain open; consequential safety disclosures remain visible. |
| 30 | Memory | Authorized combined Chat/global search exists. Internal populated cleanup and staged rollback source changes are integrated through `e0a9414e9` but remain behaviorally unqualified; unknown effects and uncertain scopes remain held. Real-provider seeded recall and misuse review remain open. |
| 31 | Interface + Runtime | Shared streaming/voice primitives exist. A voice draft is isolated and is not integrated. Full surface coverage, clean-render recordings and required call latency remain open. |
| 32 | Runtime | The pinned finite framework-capability inventory and final-resource capture source exist. A controlled real package-engine fixture has verified later Chat history and supported working-file bytes, subject to the scope below. **Missing/held:** portable executable final-resource continuation lacks independently verifiable original completeness/effect evidence. Matched example execution and framework qualification remain open. |

## Final-resource capture evidence

Source at `af9eb06c9` captures post-drain generation-zero state before cleanup
for resources with issued checkpoints; its focused tests passed using synthetic
package contents. The subsequent real package-engine fixture verifies later Chat
history and exact bytes for a supported working file, while the earlier ordinary
checkpoint retains its existing file selection. The portable folder inventory
explicitly excludes `.git` and other unsupported content; this is not proof of a
complete working-folder copy. Multi-Agent capture and Local Memory remain
unqualified. Working-folder capture is integrated at `1d90cca3e`; targeted
follow-up on that candidate is underway. Portable executable continuation remains
held pending independently verifiable completeness and effect evidence.

## Build list

The Build list is not accepted merely because a component exists. Owner: Interface
for Output/Assistant/Inbox, Runtime for provider and voice behavior, Integration
for end-to-end and acceptance evidence.

| Behavior | Source status and qualification boundary |
|---|---|
| O1–O3: designation, stable per-Agent URL, direct standalone Chat | Mechanisms present; current full workflow and fresh-install qualification remain open. Output is a direct Agent Chat, not a generated report site. |
| O4–O6: attachments, voice messages and calls | Shared Chat/voice mechanisms exist; actual attachment/reload/playback/call qualification remains open. |
| O7–O9: automatic schedule, model setting, More options | Workflow-backed settings and controlled desktop/phone cases exist; complete concurrency and nontechnical usability qualification remain open. |
| O10: iOS-like quality | Blind comparison, streaming/audio recordings and judging remain open. |
| A1–A3: Assistant bootstrap, preferred model, cross-Project work | Source mechanisms exist; fresh-install and real-provider qualification remain open. |
| A4–A7: default ten-minute check, interval, issue/completion reports, alert settings | Scheduler, report and notification mechanisms exist; controlled planted-result and settings checks are partial, not full acceptance. |
| A8–A10: one speaker, move designation, workflow/model/prompt edits | Source mechanisms exist; complete concurrency and unavailable-model ordinary-switch qualification remain open. |
| A11–A13: disable/removal, re-enable only when absent, import collision | Source mechanisms exist; complete mounted and concurrent flows remain open. |
| I1: Inbox rename | No user-facing old label found in the scoped search; full code/docs census remains open. |

## UI/UX judging plan

Patrick clarified that the panel is a group of independent judging agents, not
an application feature or panel UI. Run this acceptance after implementation
is assembled; passing browser tests or improving over an earlier Ponderosa
build does not substitute for the comparison.

1. Inventory every Ponderosa and Branches screen, including all settings
   screens, transient surfaces and interactive states. Pin the actual
   Ponderosa, Branches and competitor versions. On desktop and iOS, walk the
   actual interactions, including clicks, transitions and animations; an iOS
   emulator qualifies. Assign the same representative tasks and capture
   screenshots and comparable recordings against the pinned competitors for
   the corresponding flows. Record coverage
   and any unavailable comparison explicitly.
2. Prepare one shared written 1–10 rubric covering clarity, polish, layout and
   ease of use, with descriptions for scores 3, 6 and 9. Have at least three
   independent judge agents use available Codex models (Astra, Luna, Terra or
   Sol) different from the feature builders. Each judge may use subagents of
   the same model as that judge. Judges score blind and independently, without
   seeing the other judges’ scores; the majority verdict stands. Ease of use is
   assessed by agents walking the tasks as nontechnical users.
3. For Bible §3, Ponderosa must score equal to or better than Codex, Claude,
   WhatsApp and iMessage. For §29, both Ponderosa and Branches must score equal
   to or better than Codex, Claude and iMessage and better than LangGraph and
   LangChain. The Output app also needs its required iOS Messages comparison.
4. Check recordings for zero flicker, overlap or blocking text, retain the
   folder system, and audit explanatory paragraphs/informational blocks under
   §29. Short labels and one-line hints are allowed. Preserve the actual
   security and recovery disclosures required by the user and report any
   conflict rather than silently changing the criterion.

No qualifying blind panel, full pinned competitor comparison, recordings or
majority verdict has been completed. The mounted desktop/phone checks are
functional evidence only, not the panel result. No panel UI is to be built.

## Blockers and next work

- Internal physical Chroma cleanup and staged rollback source changes are
  integrated through `e0a9414e9`; their behavior and the 12 historical server
  cases still require consolidated validation. Unknown effects remain held;
  do not blindly replay them. Patrick clarified that Local Memory is internal
  Ponderosa memory and that Ponderosa should coordinate its own concurrent
  operations without a user assurance checkbox. Unknown direct external access
  is deployment qualification. Do not touch live memory or deploy; logical
  retirement alone does not mean physical deletion.
- Finish implementation gaps above and re-evaluate reviewed continuation on
  one-shot/Windows/legacy evidence and multiple uncertain roots without blindly
  replaying effects. Do not treat provider prompt fences as proof a model
  understood an instruction.
- Patrick clarified that normal website/browser protections should remain;
  the generic-header-removal draft is abandoned and must not be integrated.
- Run consolidated whole-product and Bible qualification only after the
  authorized implementation is assembled; report exact skips, failures,
  real-provider limits and human-only handoff items.
