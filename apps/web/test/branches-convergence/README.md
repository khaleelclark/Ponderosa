Branches convergence qualification

From apps/web, run `pnpm exec rsbuild dev --config test/branches-convergence/rsbuild.config.ts`.
Then run `CHROMIUM_PATH=/path/to/chromium node test/branches-convergence/browser.mjs`. The runner uses the server's frozen `playwright-core` dependency; `PLAYWRIGHT_PACKAGE` optionally selects another package-resolution root. The fixture supplies typed budget and operational-status responses, and the runner rejects page errors.
The fixture renders the real Branches view against isolated read-only fixtures; it blocks mutations. The browser check covers disabled execution, URL reload, parameter navigation guards, initial settings failure/retry, mobile drawer focus, light/dark geometry, and Chat composer bounds with a reduced keyboard viewport. A 640×422 CSS viewport represents a 1280×844 desktop at 200% effective zoom; real browser zoom and mobile keyboard calibration remain manual checks.

Also compare the actual preview with Dev at 320, 375, 768, and desktop widths. Check profile/global settings, notification decision navigation, Agent work log/runs/files, attachment and dictation controls, trigger fields, graph description, keyboard focus, real 200% zoom, and mobile software keyboard behavior.

The fixture rejects unscoped shared API requests with 404. `product-transport-browser.check.mjs` separately bundles actual realApi against canonical disposable server resources and verifies Branch JSON/collections, foreign Dev denial, per-product coalescing and direct export/frame namespace selection. `form-save-browser.check.mjs` runs against this fixture and covers delayed parameter/limit saves and the actual Branch/Chat/Agent capability callers, all pending controls, failure/retry, dirty guards and revision acknowledgments.
