# Chat responsiveness and copy correction

Base: `f0aafbb9e3007d2740dbe09b6c39cdf1041ecd72` (experimental Beta 10).
Branch: `fix/chat-responsiveness-copy`. Writer: this Codex task.
No merge, deployment, live message sends, live uploads, or live draft writes.

## Root causes and changes

- Copy actions used underlying routed text while rendering removed the routing-only broadcast prefix. Project, Agent, and All Messages copy actions now use the same existing visible-text helper as rendering. No routing or mention-editor changes.
- PNG previews always used compression level 9. Standard lossless level 6 avoids expensive marginal compression. Pixel content, dimensions, validation, original files, quotas, and durable writes are unchanged. Quota-borderline previews still retry the old level-9 encoding before rejection.
- Exact communication reconciliation loaded every runtime Communication twice, and room-message lookups materialized whole chat histories. Exact runtime and projected-message lookups now reuse the existing read models. Legacy mismatched runtime/event identities keep Project-scoped recovery; the second authoritative scope check remains in place.
- Successful Project-chat sends ignored their canonical message until a separate refresh completed. Broadcast and Direct Message acknowledgements now publish the confirmed message into the existing React Query cache before Composer clears. In-flight pre-send reads are cancelled; existing/newer copies are not duplicated or overwritten. Recovery-only acknowledgements do not fabricate a message. Background invalidation remains enabled.
- Existing fixed-size image thumbnails use native lazy loading and asynchronous decoding. Their dimensions, cropping, original downloads, and preview navigation are unchanged.

## Measurements on Pine

Fresh disposable roots, 3 Projects, 36 Agents, engines disabled. Same deterministic 2048×1536 JPEG (159,365 bytes), 3 uploads; 30 passive text sends containing approximately 3 KB each. Uploads and text sends were measured separately, not as attached-photo sends. Loopback HTTP, sequential workload, no production-sized benchmark.

| Operation | Before p50 / p95 / max | After p50 / p95 / max |
| --- | --- | --- |
| Upload, n=3 | 1444 / 1488 / 1488 ms | 338 / 371 / 371 ms |
| Passive text send, n=30 | 11.93 / 15.31 / 19.78 ms | 5.79 / 7.53 / 16.94 ms |

Median reductions: approximately 77% upload and 51% send. These are small-sandbox results, not claims about live 0.9–1.9-second sends or active provider delivery.

Isolated encoding profile, four repetitions: level 9 took 1435–1442 ms versus 328–330 ms at level 6. Preview size increased from 1,685,107 to 1,828,038 bytes (8.5%). A regression compares decoded pixels and verifies malformed trailing image data is still rejected. Random-noise images did not show the same compression speedup; gains are content-dependent.

Read-only Chromium comparison against the user's Project chat, same candidate/baseline static-asset substitution and viewport. All non-GET/HEAD/OPTIONS requests blocked, service workers disabled; clipboard intercepted in memory. 29 message copies checked per build: hidden broadcast prefixes **3 → 0**, no page errors.

Initial image requests **25 → 10**; encoded image bytes **9,304,176 → 4,152,423**. Off-screen images load when scrolled toward them, rather than being removed.

General browser performance did not demonstrate improvement in this single live-data pair: composer-ready navigation 4.79 → 4.86 seconds; startup long-task time 6.16 → 7.05 seconds; 10-second idle task time 1.37 → 1.78 seconds. Live Agent activity and machine load were not controlled. This does **not** establish an idle regression or a general responsiveness fix; further controlled main-thread profiling remains necessary. No typing-latency or exact click-to-paint guarantee is claimed.

## Verification

- Production build and web typecheck.
- 84 focused server checks: delivery scope/replay, draft validation, lossless image preview, exact-path regression.
- 175 web checks: includes canonical receipt publication, stale in-flight fetch cancellation, deduplication, newer edit preservation, wrong/unloaded Chat isolation.
- 8 Agent coordination/replay checks.
- Read-only browser copy comparison above; candidate screenshot inspected.

Run `pnpm build`, `pnpm --filter @ponderosa/web typecheck`, and `pnpm --filter @ponderosa/web test:built`.

Focused server command: `node --test apps/server/test/chat-responsiveness.test.mjs apps/server/test/conversation-delivery-scope.test.mjs apps/server/test/draft-input-validation.test.mjs`.

For repeat timing, start the existing `apps/server/test/performance-sandbox.mjs` from the checkout root, then run `apps/server/test/chat-responsiveness-benchmark.mjs`. It requires the disposable sandbox marker and rejects non-disposable roots. Stop that sandbox and remove only its recorded temporary directory afterward. Never point it at a live instance.

Browser check: `apps/web/test/chat-responsiveness/browser-check.mjs`, with `CHAT_URL`, `WEB_DIST_BEFORE`, `WEB_DIST_AFTER`, and optionally `PLAYWRIGHT_PACKAGE`, `CHROMIUM_PATH`, `SCREENSHOT_PATH`. It blocks all writes and reports both builds, asserting no hidden broadcast copies in the candidate.

## Remaining limits

- Network transfer, disk contention, active provider dispatch, attached-photo final sends, and typing-specific lag are not fully attributed by this workload.
- The confirmed server receipt now fills the existing cache immediately; this does not bypass time needed to durably accept the send.
- Existing large image previews remain unchanged in resolution. This patch avoids eager off-screen downloads, not full-size preview transfer when opened.
- Experimental deployment requires approval.
