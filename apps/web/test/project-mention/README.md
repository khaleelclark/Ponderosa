# Project Chat mention regression

From `apps/web`, start `pnpm exec rsbuild dev --config test/project-mention/rsbuild.config.ts`.
Then run `PLAYWRIGHT_PACKAGE=/absolute/path/to/package.json CHROMIUM_PATH=/absolute/path/to/chromium node test/project-mention/browser.mjs` with an existing Playwright installation. The overrides can be omitted if Playwright/browser are normally resolvable. Stop the loopback 21844 fixture afterward.

Uses the real Composer and synthetic API responses; no live data. The base fails after deleting its structural default destination and clicking Mention Boston. The fix must pass clear/reinsert, repeated clicks, multiple mentions and preserved typed text.
