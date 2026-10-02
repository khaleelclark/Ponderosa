# Decision-answer recipient follow-up — PR #605

## Scope

Review only the follow-up diff from previously approved commit
`ad1014ac4c15a53878795b376121cb2d337125b7` to the new PR head. The rest of #605
was independently approved already. Do not merge, deploy, update the existing
user-testing sandbox, or modify live data. Use a separate read-only review
worktree and disposable fixtures.

The original Project Chat response omitted both the recipient and a way to
view the question. The baseline browser fixture reproduced that omission at
320, 390 and 1440px against the approved source.

## Required behavior

- Text answers read `Answered #Boston: …`; choice answers read `Chose for
  #Boston: …`; approval answers read `Approval response to #Boston: …`.
- The highlighted mention navigates by `decision.agentId`. It is never
  inferred from answer text, an option label, or a loaded roster.
- Project Chat, Agent Chat and All Messages use one response renderer.
- “View question” opens a read-only, accessible dialog for that exact canonical
  Decision, including its original question, context and choices. Closing,
  viewing and navigation do not respond, acknowledge, dismiss or settle work.
- Current recipient identity is projected with exact-ID, same-Project checks.
  Renamed Agents remain navigable. Missing/deleted Agents have no navigation
  action; the original question and answer remain readable. Older DTOs without
  identity metadata show an honest unavailable label.
- Historical automatic permission responses retain their existing notice
  wording and do not become user-authored answers.

## Authority constraints

The response renderer and recipient metadata are presentation only. No handle
is prepended to the stored answer, no Communication is created, and Decision
resolution, Activation routing, provider context selection and permissions
remain unchanged. Showing an answer does not claim that the Agent consumed it
or finished the work.

Agent Chat gains a bounded read-only projection of existing canonical Decision
events, not a second log. Its history cursor combines message and Decision
pages, binds to the Agent ID, and still accepts valid legacy message cursors.
The per-Agent event index is rebuilt from the same canonical events on reopen.
Check pagination, deduplication, scope fencing and older-page merging carefully.

## Verification

Run with Node 24:

```sh
pnpm install --frozen-lockfile --offline
pnpm verify
node --test apps/server/test/decision-recipient-presentation.test.mjs
git diff --check
```

Set `PONDEROSA_PLAYWRIGHT_PATH` to the installed `playwright-core/index.mjs`.
For Chromium, also set `PONDEROSA_CHROMIUM_PATH` to a local Chrome executable:

```sh
node apps/web/test/decision-recipient-browser.check.mjs
PONDEROSA_TEST_BROWSER=webkit node apps/web/test/decision-recipient-browser.check.mjs
```

The browser check uses actual Project timeline, Agent Chat and All Messages
components at 320, 390 and 1440px. It covers text/choice/approval, rename,
deletion, missing/mismatched identity, historical automatic responses, exact
question identity, keyboard activation/Escape/focus return and containment.
Its API inputs are controlled fixtures, not live managed-Agent qualification.

To reproduce the original omission, point the check at a separate checkout of
the approved baseline (the path is that checkout's `apps/web` directory):

```sh
PONDEROSA_DECISION_BASELINE=1 PONDEROSA_DECISION_BASE_SOURCE=/path/to/base/apps/web \
  node apps/web/test/decision-recipient-browser.check.mjs
```

The disposable real-route test verifies one response and one exact targeted
Activation after replay, unchanged canonical answer text, no fabricated Chat
message, bounded history, wrong-Agent cursor rejection, rename/deletion, and
store reopen. Store reopen is not a full application crash/restart test.

Report actionable findings with file/line, exact revisions, reproduction and
impact. State code-merge and controlled-dev verdicts separately. Do not call
absent GitHub checks green or claim production/platform qualification.
