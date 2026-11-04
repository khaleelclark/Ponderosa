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
| 15 | Portability + memory | User-folder custody protections exist and pending cleanup is shown. **Missing/held:** populated Chroma cleanup and rollback remain unresolved; 12 historical server cases remain failing or unqualified. |
| 16 | Runtime | Trigger occurrence identity, catch-up and logging exist; all timing, clock-change and reason-trail acceptance remains open. |
| 17 | Integration | A controlled populated upgrade and focused regressions passed; the final whole suite, crash qualification and 20 consecutive controlled core-path runs remain open. |
| 18 | Interface | Notification settings and grouped browser displays exist; controlled bursts were checked. Actual push/OS behavior, all settings and mention semantics remain unqualified. |
| 19 | Integration | Activity and audit records exist. **Missing/held:** unexpected Branch deletion errors can be withheld rather than giving the complete real cause because a general exact-secret-value redactor is unavailable. Ten UI trails and plain-language judging remain open. |
| 20 | Integration | Origin checks remain and no operator-token gate was found in inspected paths. The reviewed change removing generic CSP, X-Frame-Options, HSTS, Referrer-Policy and X-Content-Type-Options from the global response hook was rejected by automatic approval review and is not integrated. Route-specific origin/preview isolation requires separate interpretation. |
| 21 | Interface | Streaming and bounded rendering exist; the Bible's 10,000-message/20-active-Agent, desktop/mobile Event Timing measurements remain open. |
| 22 | Integration | Installer, bootstrap and docs exist; the fresh docs-only install-to-first-reply timing remains open. |
| 23 | Integration | Current guidance exists and a stale peer-steering instruction was corrected. Exhaustive documented-behavior execution and documentation reconciliation remain open. |
| 24 | Interface | The usage screen now treats incomplete component totals as unavailable and displays exact token counts, duration and coverage; full UI metric census remains open. API partial sums require `metricAvailability`. |
| 25 | Runtime | Native subscription/API detection and switching mechanisms exist without a mandatory picker; real-account mode switching, capability parity and state preservation remain unqualified. |
| 26 | Interface | Shared components exist; a complete common-action/component inventory and visual judgment remain open. |
| 27 | Interface | Theme and text-size controls exist; keyboard, screen reader, contrast, zoom and automated accessibility qualification remain open. |
| 28 | Integration | Branches uses shared Core paths, but every Bible requirement must separately be qualified for Branches; aggregate parity remains open. |
| 29 | Interface | Folders and shared Output/chat UI exist. Full copy census, screenshots, recordings and blind comparison remain open; consequential safety disclosures remain visible. |
| 30 | Memory | Authorized combined Chat/global search exists. Real-provider seeded recall and misuse review remain open; populated cleanup, rollback and uncertain scopes remain held. |
| 31 | Interface + Runtime | Shared streaming/voice primitives exist. Full surface coverage, clean-render recordings and required call latency remain open. |
| 32 | Runtime | The pinned finite framework-capability inventory exists. **Missing/held:** portable final-resource continuation lacks independently verifiable original completeness/effect evidence. Matched example execution and framework qualification remain open. |

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

## Blockers and next work

- Physical Chroma cleanup/rollback remains held. The user is considering the
  sole-writer tradeoff; do not assume it or deploy. Logical retirement and a
  pending-cleanup notice do not mean physical deletion.
- Finish implementation gaps above and re-evaluate reviewed continuation on
  one-shot/Windows/legacy evidence and multiple uncertain roots without blindly
  replaying effects. Do not treat provider prompt fences as proof a model
  understood an instruction.
- Integrating generic response-header removal was rejected by automatic
  approval review; the draft remains isolated. The review cited broad removal
  of browser security protections without explicit authorization. No retry is
  authorized by elapsed time.
- Run consolidated whole-product and Bible qualification only after the
  authorized implementation is assembled; report exact skips, failures,
  real-provider limits and human-only handoff items.
