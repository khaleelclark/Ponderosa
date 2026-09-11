# Message request action browser regression

From `apps/web`, run `pnpm exec rsbuild dev --config test/message-request-action/rsbuild.config.ts`.
In another terminal run `PLAYWRIGHT_PACKAGE=/absolute/path/to/package.json CHROMIUM_PATH=/absolute/path/to/chromium node test/message-request-action/browser.mjs` using an existing Playwright installation. Overrides are optional if normally resolvable. No new product dependencies required.

The fixture uses the real message frame, shared action CSS, request action and lifecycle card. Request responses are intercepted synthetic data; no live server or Projects are touched. Stop the fixture server on loopback port 21844 after testing.
