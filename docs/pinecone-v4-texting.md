## Appearance restoration — 2026-10-13 23:51 UTC

The user confirmed that original v4 started in dark mode. The isolated entry had hardcoded `createPonderosaTheme('light')`, bypassing the original `loadColorMode()` mechanism. Port 18795 is a distinct browser-storage origin from 18793, so its previous theme key is not automatically shared. The refined entry now uses the original theme loader, palette, `ponderosa-color-mode` key, optional browser-storage helper and document color-scheme behavior. The theme and storage-helper sources exactly match original v4. When this new origin has no valid explicit choice, the known original dark choice is restored; a valid saved light/dark choice is retained. The original appearance toggle behavior is available in the existing small conversation menu and persists only that appearance key. No cross-origin private storage export or unrelated settings write occurs.

Actual served Chrome verification on port 18795 passes ten cases across 390×844 mobile and 1440×900 desktop: dark-device/no preference, light-device/no preference restoring known prior dark, saved dark over a light device, saved light over a dark device, toggle plus reload retaining the draft and an unrelated storage sentinel, and storage denied with safe memory fallback. Body, composer, user/assistant messages and menu computed foreground/background contrast exceed 4.5:1. The native color scheme is dark, and the focused texting layout keeps its dimensions. Dark mobile/desktop and menu screenshots were visually inspected after menu animation finished. Build, TypeScript and served-index hash checks pass. No test sends a message or mutates an application API.

Deployment copied versioned static assets first and atomically replaced index.html; neither the UI server nor the baseline daemon restarted. V4 remains paused with identical Branch configuration and GPT-5.6 Sol/high; v3/v5 schedules are unchanged. Evidence is sibling `evidence/v4-appearance/after-verification.json`, `after-dark-390.png`, `after-dark-1440.png`, `after-dark-menu-390.png`, `original-theme-source-proof.json`, `runtime-preservation.json` and `deployment.json`. Roll back only this theme build with its `previous-index.html`; all prior static assets remain. Existing open tabs receive the fix on refresh.

Automatic approval review rejected a LAN-visible staging listener because it could expose private conversation data. The permitted safer alternative, loopback-only staging with all writes denied, was used successfully and stopped afterward. No permission request or unresolved blocker remains.

# Pinecone v4 texting refinement — 2026-10-13

Current writer: this delegated task, sole writer in `/Users/patmi/Documents/Codex/2026-10-13/task-2/candidate-source`. Branch `codex/pinecone-v3-v5-shadow-20261013`; this follow-up starts at `76ca1b10863b4eaed7c834625b55d3192a19c91b`. The user's correction redirects the product around the actual v4 interface, not further numbered designs. No new Branch, Chat, Agent or organization was created.

Verified user URL: http://192.168.1.147:18795/branches?branch=0356095a-8d73-4249-b39d-883b978ae119&tab=pinecone

This is the original v4 Branch `0356095a-8d73-4249-b39d-883b978ae119`, same spokesperson `f1e52ee0-6966-471c-bfe4-c9d04233a39a`, same conversation `1982c3cc-702b-5f2b-aab9-76abe3f5c277` and canonical history. The existing isolated UI server now defaults to this v4 view. The daemon and original full application on port 18793 remain intact, including advanced views. This UI has not been integrated into product release source or published/merged.

## Actual failure and scoped repair

A labeled harmless test sent through v4's original browser interface returned HTTP 202 and a canonical user-message receipt, but produced no reply after three minutes. The exact delivery receipt became failed. A read-only inspection of the failed scheduler Run evidence identified `paginated_threads is not supported yet`, at prompt submission, not injected. Recent v3/v5 spokesperson failures showed the same provider error. This demonstrates that earlier completed research executions did not qualify continuing chat.

The existing Agent PATCH control was used once to reapply its exact existing `workingCopyMode: shared`. That native control fences changes, rejects active Runs, tears down only its idle provider runtime and clears its resume cache. The same registered folder mode, root path, model, reasoning, Agent and conversation were verified afterward. Canonical history was retained. No database mutation, authentication change, permission expansion, new connector, model change, prompt change or engine architecture patch was performed. This is an operational recovery of the incompatible saved provider session, not a claim that every possible future provider failure is fixed. V3/v5 caches were not modified under this redirected v4 scope.

A harmless retry then produced the real canonical assistant reply `UI check received: blue lantern`, from completed provider Run `f14fc4c7-c32e-4c9e-b2fa-b1e401109352`, GPT-5.6 Sol/high. The new UI was then tested through its actual composer with two further authorized follow-ups. Neither prompt supplied the remembered phrase:

| Test | Actual canonical reply | Completed provider Run |
|---|---|---|
| Ask for the two-word phrase from the prior reply | blue lantern | b837003c-b993-4e74-afc4-58c9b8f876a9 |
| Ask to repeat that phrase in uppercase | BLUE LANTERN | f8ef68fd-8497-4f91-bc3e-f2620a319426 |

Both Runs verified GPT-5.6 Sol/high, unchanged from v4. Replies were authored by the exact spokesperson, scoped `user_dm`, in the exact existing conversation, with matching execution IDs. The browser checked the actual reply after scrolling to the bottom and confirmed the composer did not cover it. The first reply arriving while the reader was at the top of earlier messages preserved scrollTop=0. Tests permitted only the two labeled v4 message POSTs and blocked every unrelated write. Test messages remain in canonical history; no history was deleted. No email, third-party message or other test conversation was used.

## UI refinement

`V4Pinecone.tsx` derives directly from the original served v4 `BranchPinecone.tsx`, preserving its message routing, idempotent submission, draft retention, same-message retry after uncertain acknowledgement, citations, documents, attachments and pending decisions. It retains v4's existing colors, Pinecone mark and message treatment.

The primary screen contains a compact 56px header, messages and a straightforward composer. A small three-dot menu retains Files & team, research history, notifications and the original discovery controls. Marketing copy, research dashboards and the large status card are absent. Delivery state comes from canonical message delivery receipts through the existing status component; failed messages visibly say that Pinecone could not reply and that the message is saved. An accepted request is labeled saved/waiting, rather than falsely implying a completed assistant reply.

The entry reuses the existing VisualViewport helper and Android resize-content viewport metadata. The composer stays in normal flex layout with safe-area padding. Messages have independent scroll; reader interaction suspends automatic bottom following until the reader returns to the bottom or explicitly sends. A bounded five-second canonical detail refresh keeps delivery failures truthful even when their projection is not refreshed by a live stream.

The proxy gained only explicit ownership for the existing v4 spokesperson, trigger and Check now path. Client routing/model overrides remain rejected. Candidate 3/5 policy and models remain intact. Typed Branch navigation now preserves nested workspace routes, fixing the earlier preview entry's dropped Files/team destination.

## Render and deployment evidence

Actual local Chrome on Patrick's Mac rendered the original baseline and refined served UI at 360×740, 390×844, 430×932, 390×360, 844×390 and 1440×900. At 390×844, v4 conversation space increased from 455px to 718px; at 390×360, it increased from 16px (with the old composer below the viewport) to 234px. Desktop conversation height is 774px versus 607px before. Menu controls remain discoverable. Scrolling the real long conversation, a twelve-line unsent draft constrained to three rows, Chromium safe-area insets, and an overlay keyboard reducing the visual viewport to 360px all pass. A physical Android keyboard was not tested.

Build and TypeScript pass. Three ownership policy tests pass. The actual served index hash matches the deployed build. Static assets were copied before the atomic index replacement, retaining previous assets. Only recorded isolated UI PID 48839 was replaced by PID 66849 to load v4's scoped proxy path; the original daemon PID 87824 was not restarted. The temporary read-only staging server is stopped after verification.

Evidence in sibling `evidence/v4-texting/`: `baseline-390x844.png`, `after-390x844.png`, desktop screenshots, `verified-chat-1.png`, `verified-chat-2.png`, `refined-chat-e2e.json`, `final-verification.json`, `provider-failures.json`, `compared-runtime-failures.json`, `supported-session-refresh.json`, before/after render proofs, and `deployment.json`. The canonical proof contains only test messages and matching Run receipts. Runnable render check: `experiments/pinecone-shadow/v4-texting-browser.check.mjs` with the existing Playwright and Chromium environment paths. Real-message E2E instructions remain explicitly labeled in the sibling `v4-chat-e2e.mjs`; do not rerun without test-message authorization.

## Preserved state and rollback

V4's trigger remains disabled, with its ten-minute definition preserved. Configuration hash, model/reasoning, Branch definition/bindings and identity match the before snapshot. V3 remains enabled every twelve hours and v5 every ten minutes. No other schedules were changed or resumed. Existing original v1/v2 states were untouched in this task.

UI rollback: restore `evidence/v4-texting/before-preview-index.html` atomically to the isolated `candidate-web-dist/index.html`; all prior assets remain. Restore the saved `before-preview-server.mjs` to the isolated proxy and restart only its recorded UI PID after verifying the exact command. No agent or database rollback is needed. The recovered provider cache uses canonical history; restoring the incompatible old opaque cache is not recommended. All source edits are in the existing isolated branch with no unexpected dirty files; exact final head is in sibling `evidence/git-checkpoint.json`. No push, PR, release publication or merge occurred; reviewed integration remains a separate decision.

The existing Branch system supports comparing organizational roles behind this same conversation. A later small experiment could compare the current Scout → independent Reviewer → spokesperson with one narrowly scoped specialist Scout, using bounded shadow checks and the same relevance/delivery gates. No organization, prompts or cadence were changed on the user's tentative “maybe.”
