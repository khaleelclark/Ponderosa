# Core initial Project route code overlap

Base: a1ea41bbc6c0ed209d4d9dea34cde8f4649dacff. Owned branch: codex/core-route-loader-20261106.

The retained production phone receipt at `/tmp/p2memo-proof-hUaND5iH/evidence/sessions.json` showed Core ProjectShell dependencies starting 940–947 ms, after App dependencies at 304–307 ms. The emitted App chunk contained the exact nine-chunk ProjectShell loader. Bootstrap now calls that existing shared loader alongside App loading for an existing parsed Project route. Later navigation and recoverable lazy-route retry retain the same loader; no API query, permission, message count or rendering behavior changes.

Private checks on this patch:

- Web TypeScript check: passed.
- Owned production web build: passed.
- Controlled phone browser checks: 3 passed, 0 failed, 0 skipped. Held App response while ProjectShell code was requested, with zero API requests before App mounted; cold Home left ProjectShell unloaded until Chat selection; rejected ProjectShell code recovered through the existing explicit Try Again action and reached the Chat editor.
- Corrected receipt: `/tmp/p2loader-aib4wo4L/evidence-corrected/results.json`. Context, browser and fixture cleanup all completed; scoped process inspection found no remaining owned process.

Command: `QUALIFICATION_DIRECTORY=<owned> node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/core-route-code-overlap-qualification.mjs` after web build (Node 24, installed Chrome, controlled fixture only).

The first trial caught a check-order race: Playwright emitted the request before its route handler recorded the held response. It made no product claim; the failed receipt remains in `/tmp/p2loader-aib4wo4L/evidence/results.json`. The check now waits for actual interception. These functional checks do not establish an LCP improvement or performance qualification.
