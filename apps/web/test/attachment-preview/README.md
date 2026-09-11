# Attachment preview browser regression

Uses the actual shared attachment component and synthetic files only. No server or user data required. With the existing workspace dependencies installed, from `apps/web`:

```sh
pnpm exec rsbuild dev --config test/attachment-preview/rsbuild.config.ts
```

In another terminal, use an available Playwright installation (no new product dependency):

```sh
PLAYWRIGHT_PACKAGE=/absolute/path/to/package.json CHROMIUM_PATH=/absolute/path/to/chromium node test/attachment-preview/browser.mjs
```

The environment overrides are optional when Playwright and its browser are already resolvable normally. The fixture binds loopback port 21844. Stop that fixture server when finished.
