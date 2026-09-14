# Confirmed-send cache regression

This fixture uses the real Composer, React Query mutation lifecycle, and receipt publisher with an in-memory send. API requests are intercepted; no real Project, draft, message, or provider is used.

From `apps/web`, using the repository's Node 24 runtime:

```sh
pnpm test:built
pnpm typecheck
pnpm exec rsbuild dev --config test/confirmed-send/rsbuild.config.ts
# In a second terminal, with Playwright installed externally:
PLAYWRIGHT_PACKAGE=/path/to/package.json CHROMIUM_PATH=/path/to/chromium node test/confirmed-send/browser.mjs
```

The browser fixture listens only on `127.0.0.1:21846`. Stop it after qualification. No Playwright dependency is added to the product.

## Evidence (2026-09-12)

Base: `0e08302bdf7aee7141c7aa9bfaa4e7a5f9dc3283`.

- Before the fix, adding a sibling active-delivery-receipts cache reproduced `Cannot read properties of undefined (reading 'some')` inside the successful send's mutation callback: 175 checks passed, the new regression failed.
- After the fix: all 181 web checks passed, web typecheck passed, full production build passed.
- Real QueryClient/MutationObserver regression checks cover multiple conversation page sizes, unrelated receipt data and in-flight receipt reads, stale detail-read cancellation, deduplication, unloaded conversations, cache cancellation/publication/refresh failures, and actual request rejection.
- Browser: normal accepted send, injected cache failure after acceptance, and actual send failure all passed. Accepted sends clear the submitted text without a false failure banner; real failures retain the draft and show the failure. Each case makes exactly one in-memory send attempt.

The production change is limited to `conversationMessageReceipt.ts`. It narrows cancellation/publication to conversation detail keys and logs/revalidates projection failures without rejecting an already accepted send. Composer styling, routing, server delivery, and attachment handling are unchanged. This fixture does not claim a live provider round trip.
