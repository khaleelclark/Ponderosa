# Consolidated mounted regressions

`pnpm verify` runs the ordinary build/typecheck/Node verification, then
`pnpm test:mounted`. The latter builds one maintained browser entry and runs every
exported function from the registered `*-mounted.tsx` fixture modules once on a
desktop viewport and once on an emulated phone. The current entry covers 36 cases
from 22 modules. These are mounted production components with controlled fixture
APIs; this does not claim a real provider session or full production integration.

The Node inventory bridge in `tests/chats/mounted-regression-inventory.test.mjs`
requires every mounted fixture with exported regressions to appear exactly once
in `tests/shared/mounted-regressions.tsx`. Exported case names must be unique.
Adding another function to an included module automatically adds its browser
cells. Adding another module requires one explicit entry import and inclusion in
the fixture list. The browser verifies its exposed names against the same source
inventory before invoking cases, and refuses to run two cases in the same page.
The standalone additive-memory and live-output fixture applications retain their
existing dedicated browser/configuration scripts; their real Fastify/memory and
SSE qualifications remain separate from this controlled mounted suite.

Run from the repository root after all implementation is integrated:

```sh
pnpm verify
```

When the build/typecheck/Node phase has already completed on the same combined
source, run the mounted suite without repeating that phase:

```sh
pnpm test:mounted
```

The runner uses the existing Rsbuild, React and `playwright-core` dependencies.
It launches the Chrome executable from `PONDEROSA_CHROME_PATH`, defaulting to
`/usr/bin/google-chrome`; it never installs a browser or other dependencies. Each
case gets a fresh browser context, storage and DOM. Desktop is 1440×962; phone is
390×844 with touch/mobile emulation. The entry serves from an owned loopback HTTP
listener. External requests and unmocked API calls fail their cell. No provider,
production service, user data directory or real microphone is used; the recording
fixture supplies its own permission and recorder implementation.

Fresh build and evidence directories are created under a new temporary root and
the evidence path is printed before work starts. To select paths explicitly, set
`PONDEROSA_MOUNTED_BUILD` and `PONDEROSA_MOUNTED_EVIDENCE` to fresh empty absolute
directories. Existing contents are preserved and refused. `results.json` records
all case names, both viewport outcomes, durations, page/network errors and cleanup
failures. Failed cells also attempt screenshots. Optional
`PONDEROSA_MOUNTED_VIDEO=1` records video using the existing Playwright ffmpeg
cache; no installation is attempted. Each case has a 30 second limit, configurable
between 1 and 120 seconds with `PONDEROSA_MOUNTED_CASE_TIMEOUT_MS`; the single
harness build has a three minute limit. Failed cases are recorded without retries,
and independent later cells still execute. Browser/context/listener cleanup
errors fail verification while preserving the primary failure evidence.

This change supplies the previously missing execution wiring. No browser,
TypeScript check, build or test was run while implementing it. The combined final
validation must record actual results before any execution claim is made.
