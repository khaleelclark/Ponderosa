# Independent review: UI Round 2

Review the single PR on `fix/ui-round2-composer-mobile-20261002` against
`c22bbcb29c651061a9bab72e63c093b800058cab`. Resolve and record the remote head
before starting; reconfirm it at completion. Read `AGENTS.md` and review the
aggregate diff in a separate, read-only detached worktree. Do not alter the
candidate, PR state, existing sandboxes/browsers, live Agents, services, dev,
production, or user data. Use only disposable fixtures. Do not send live work.

The scope and runnable commands are in `docs/ui-round2-qualification.md`.
Independently verify, rather than treating implementer results as qualification:

- Optimistic rendering clears the visible composer immediately, while failures,
  newer edits, draft CAS authority, attachment recovery and navigation stay safe.
  Receipt text is still based on canonical admission/delivery, not local echo.
- Explicit and implicit new-Agent creation has one message while the canonical
  opening and final draft cleanup arrive. The pending creation chip resolves to
  the exact accepted stable ID and current handle. Rename/deletion/cross-Project
  identity is safe. Original opening text, intake keys, scope, routing, Runs,
  context selection and delivery authority are unchanged.
- Autocomplete and first typing before/after send leave the caret after an
  atomic chip. Test immediate typing, mouse/touch focus, selections, Backspace,
  paste/drop and IME boundaries; ensure deferred focus cannot overwrite edits.
- Touch model selection preserves editor focus/caret and remains usable after
  keyboard-sized viewport changes and rotation. Keyboard navigation and Escape
  still work. Picker and microphone controls do not remount at breakpoints.
- File/download links are visibly clickable and keyboard-focusable without
  changing authorization, URL admission or download behavior.
- Mobile Chat/Agent headers retain accessible status details, Stop, usage,
  browser/menu and tab controls at 320/390/430px; desktop remains usable.
  Compact follow-ups say Dismiss and preserve exact guarded retry semantics.
- The Attention review dialog presents one unknown-outcome warning, keeps
  status/time/Chat/Agent/issue context and moves full retained cause/record IDs
  to Details. Long previews must remain readable via keyboard/touch expansion
  at 320/390px and desktop. Preserve missing-evidence fallbacks, exact activity
  targets, notice-only Dismiss, confirmed/idempotent retry, pending Decisions,
  and full support reports. Viewing, expanding and closing must not mutate
  notice/work authority. The Notifications panel is not otherwise redesigned.
- Modified & Created Files remains newest-first after refresh and older-page
  loading; no filesystem-mtime guarantee is implied.
- Starred folder expansion is independent from All Chats in both directions.
  Check one-time legacy seeding, reload/remount, search restoration, rename,
  unstar/re-star and denied device storage. Starred toggles must not change
  canonical workspace preferences, folder membership/stars, notification counts
  or routing. All Chats retains the existing expansion preference. Run
  `chat-folder-notifications-browser.check.mjs` in Chromium and WebKit, including
  its existing 401-folder bounded projection, loading/failure and count checks.
- Live progress uses one shared disclosure renderer in Project Chat, Agent Chat
  and All Messages. Verify working/command/tool/browser labels come from exact
  open-call evidence and registered browser-tool identity, never public prose,
  reasoning, inputs or outputs. Closed/missing/foreign spans must not mislabel
  activity. Preserve acknowledged Run/injection eligibility, bounded latest-only
  text, reply/terminal suppression, and Work log retention after reopening.
  Collapse must persist for the exact Agent/execution across updates, steering,
  movement and remounts; a new Run defaults expanded, and other Agents remain
  independent. Check keyboard/touch disclosure, accessible controls/expanded
  state, long names, mobile/desktop, and the previous actual-overflow regression.
  Run `live-agent-progress-browser.check.mjs`, focused `public-progress.test.mjs`
  and `request-storm-browser.check.mjs`; verify activity refresh is bounded,
  hidden tabs stay quiet, phase-health cadence is unchanged, and no new provider,
  Communication, routing, permission or receipt authority is introduced.
- Ponderosa microphone requests final results only. Test the modeled Android
  growing-partial failure, rapid final callbacks, replayed indices, pause/resume,
  stale callbacks, typed text and intentional repeated words. Do not deduplicate
  prose or claim that mocked callbacks prove physical-phone behavior.
- Review the steering scheduler change as backend concurrency, not only UI.
  Reproduce the old cross-Agent preparation/startup block, then verify polling
  admits exact-Run steering before the slow gate is released. Check slow steering
  isolation, same-Run ordering, global Run budget, stop/pause barriers including
  all in-flight dispatches, quarantine/budget changes during async intake checks,
  cancellation/deletion/fence advancement, preparation failures and watchdogs,
  outbox audit/teardown barriers, and no duplicate original/recovery Runs. Read
  `steering-admission.test.mjs`, run it plus `coordination-outbox-permanent.test.mjs`
  and `steering-wait-reasons.test.mjs`, and inspect the actual dispatch integration.
  Wait reasons must come from canonical barriers or safe observed enum deferrals,
  not prose. Verify new schema upgrade/reopening, historical null compatibility,
  pending/accepted/terminal distinctions, stale deferral precedence, explicit Queue
  semantics and unchanged canonical prompt/scope/retry authority. Run the updated
  three-surface Chromium/WebKit fixture for all waiting labels; tool cancellation
  or immediate semantic reconsideration must never be implied by acceptance.
  Use only disposable deterministic workloads unless separately authorized; do
  not steer/interfere with existing live Agents for qualification.
- Review the folder/general-file follow-up as an admission expansion. Check
  opaque font/office/source/media/archive originals through HTTP, drafts,
  prepared promotion, runtime reads and reopening. Protected image/document
  validation cannot fall through to opaque admission. Opaque files must not
  silently gain active preview/installation/execution, authority or access.
- Check folder ZIP interoperability, CRCs, UTF-8 paths, full paginated traversal,
  exclusions and truthful feedback. Prove byte/count/depth/time bounds, unsafe
  and duplicate paths, read failure, empty folders and cancellation/navigation.
  Verify folder picker/drop at mobile/desktop widths. No partial folder or
  late archive may attach into another Chat; archive members remain untrusted.

Run focused browser checks in Chromium and macOS WebKit where available, focused
Agent projection tests, typechecks, production builds, `pnpm verify`, and
`git diff --check`. Separate missing platform qualification from failures.
Source-trace all callers of changed shared renderers/projections. Check for
unnecessary complexity, unsafe identity matching and unrelated changes.

Report actionable findings with severity, file/line, concrete reproduction and
smallest fix. State the exact head/base and evidence/limitations. Give separate
code-merge and controlled-dev verdicts; production release is outside this
review. If no actionable finding exists, say so explicitly. Do not merge or
deploy.
