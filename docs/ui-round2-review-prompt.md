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
- Modified & Created Files remains newest-first after refresh and older-page
  loading; no filesystem-mtime guarantee is implied.
- Ponderosa microphone requests final results only. Test the modeled Android
  growing-partial failure, rapid final callbacks, replayed indices, pause/resume,
  stale callbacks, typed text and intentional repeated words. Do not deduplicate
  prose or claim that mocked callbacks prove physical-phone behavior.

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
