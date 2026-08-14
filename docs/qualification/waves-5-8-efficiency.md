# Waves 5–8 efficiency qualification

Date: 2026-08-14  
Approved base: `origin/master` at `179327e9e1d4545828207c8ceb85c6012459b8d4`  
Qualification branch: `codex/final-plan-efficiency`

## Prompt and provider-tool footprint

The measurement serializes the exact Ponderosa system/communication prompt and
provider tool definitions. Token counts use the repeatable code-point / 4 proxy
because the provider does not expose an isolated tokenizer for these host-owned
fragments. Bytes and code points are exact; proxy tokens are rounded up.

| Surface | Base bytes | Qualified bytes | Base proxy tokens | Qualified proxy tokens |
| --- | ---: | ---: | ---: | ---: |
| Runtime system + Communication prompt | 4,448 | 3,718 | 1,112 | 930 |
| All provider tool definitions | 18,182 | 18,182 | 4,546 | 4,546 |
| Combined | 22,630 | 21,900 | 5,658 | 5,475 |

The 730-byte (16.4%) prompt reduction removes dead response-contract builders
and prose already carried by the authoritative system contract or the relevant
tool descriptions. Provider tool schemas remain complete.

An independent protocol-specific serialization of the approved base provides
the more precise provider boundary: Codex `dynamicTools` were 18,434 bytes /
4,029 `o200k_base` tokens, and Claude MCP `tools/list` definitions were 18,042
bytes / 3,944 `o200k_base`-equivalent tokens. The table above intentionally uses
one provider-neutral serialization and code-point proxy so base and qualified
prompt fragments remain directly comparable; it must not be read as either
provider's framed wire size.

No tools were conditionally hidden. Codex binds `dynamicTools` at
`thread/start`, while Claude's Ponderosa MCP process derives its enabled names
from startup environment and `tools/list`; neither integration can safely change
the set during a warm provider session. Session-profile filtering is supported:
the selected definitions participate in the provider tool/session contract
hashes, so a changed profile forces a fresh provider session. Per-turn intent
filtering would instead churn that contract or strand a later workflow without
a capability. This PR deliberately leaves the registry/profile seam intact for
Wave 4's approved bounded history capability. It does not hide browser tools on
executable discovery because base discovery is not yet portable across Linux,
macOS, and Windows, and the final browser gate allowed no further production
browser slice after consolidation was rejected.

## Wave 4 integration boundary

The base measurements used committed `179327e9e1d4545828207c8ceb85c6012459b8d4`
content. No dirty or in-progress Wave 4 implementation was inspected or copied.

Exact textual overlap with Wave 4's named production paths is empty:

```text
packages/core/src/managed-tools.ts
packages/engines/src/ponderosa-mcp.ts
apps/server/src/routes/provider-run-executor.ts
```

`git diff --name-only 179327e9e1d4545828207c8ceb85c6012459b8d4..HEAD -- <those paths>`
returns no paths. The only adjacent/semantic integration sites are:

- `apps/server/src/runtime-selection.ts`: this PR edits the
  `communicationV3Prompt()` hunk immediately after `providerDynamicTools()`.
  Wave 4 may extend the latter and must continue hashing the exact selected tool
  definitions through `providerToolContractHash()` and
  `providerSessionContractHash()`.
- `apps/server/src/runtime-selection.test.ts`: this PR's new browser regression
  assertion requires the seven authority-distinct browser tools and forbids a
  generic `ponderosa_browser`; it does not cap the registry. Wave 4 should retain
  that assertion while adding history exposure/profile cases.
- `apps/server/src/routes/agent-run-preparation.ts` (unchanged here): the
  `availableRuntimeTools` selection and tool-contract hash around lines 301–309
  are the intended session-profile seam. The selected names flow unchanged into
  `provider-run-executor.ts` for Claude's environment allowlist, Codex dynamic
  tools, and server-side call rejection.

Recommended merge order is this Waves 5–8 branch first, followed by rebasing the
Wave 4 history commit onto it. Resolve `runtime-selection.ts` semantically: keep
the shorter Communication prompt, add Wave 4's bounded history selection to the
session profile, hash the selected definitions, and preserve the seven browser
tools. Then run the runtime-selection/provider-session tests for both Codex and
Claude exposure. If Wave 4 lands first, rebase this branch and reapply only the
`communicationV3Prompt()` cleanup rather than replacing Wave 4's registry or
exposure functions. No compatibility alias or dual registration is needed.

## Frontend route and PWA delivery

Current master already lazy-loads syntax highlighting. The residual eager
boundary was `App.workspace-content.tsx`, which still imported every workspace
surface on the home route. The qualified change keeps the home view eager and
lazy-loads create, Project, Wiki, settings/profile, and collection routes behind
one stable, accessible `Suspense` fallback.

Clean exact-base/head rebuilds independently confirmed a material reduction in
home-startup raw, gzip, CDP-transfer, and V8-loaded first-party script payload.
The original environment observed a reduction on the order of one third, but
its exact build outputs and per-invocation JSON were not retained. A later clean
rebuild did not reproduce the original byte table exactly. Those precise values
are therefore intentionally omitted: asset hashes, toolchain/runtime versions,
compression implementation, and the browser/build environment make them
non-invariant, and unretained figures are not an acceptance gate.

Five isolated Chrome runs against production previews produced the following
environment-specific medians:

| Home navigation median | Base | Qualified | Change |
| --- | ---: | ---: | ---: |
| Cold load | 80.3 ms | 63.8 ms | -20.5% |
| Repeat load | 36.7 ms | 34.4 ms | -6.3% |

These timing values are directional observations from the original run, not a
portable acceptance budget. The runs used local loopback, an installed
headless Google Chrome, a warm host, no CPU or network throttling, and an empty
home shell; the harness emits one raw JSON record per invocation, but those five
raw records were not retained with the PR. An independent review confirmed the
payload direction but did not reproduce these timing medians or the original
exact payload bytes. Timing must be re-measured and reported with its browser,
host load, throttling, route data, raw runs, and sample count before it is used
as a gate.

The original build also observed a small increase in total precache payload
because of chunk wrappers, bounded chunk-recovery UI, and safe artifact
presentation. Its exact byte totals are omitted for the same non-invariance and
raw-record limitation. This is accepted because startup transfer/execution
materially fell and all 18 route chunks remain in the Workbox precache. No
service-worker policy changed.

Real workflow checks:

- Desktop direct `/settings` rendered through the lazy boundary.
- A service-worker-controlled browser reloaded `/settings` offline and rendered
  a nonblank route-owned Settings subtree, including its lazy chunk. Global
  shell/sidebar text cannot satisfy the route check.
- The same direct/offline workflow passed at a 390×844, 3× mobile viewport.
- A rejected route import gets one explicit fresh-lazy retry; a second failure
  offers a user-triggered reload and never reloads automatically.
- The persistent-profile upgrade test replaced a controlling legacy worker,
  retained authentication, removed old assets, and survived browser restart.
- `/api` and launcher bootstrap navigation remain denied from SPA fallback.

Reproduce build/navigation measurements with:

```bash
pnpm --filter @ponderosa/core build
pnpm --filter @ponderosa/web build
pnpm --filter @ponderosa/web preview --host 127.0.0.1 --port 4317
node tools/efficiency/measure-web-route.mjs http://127.0.0.1:4317/
node tools/efficiency/measure-web-route.mjs http://127.0.0.1:4317/settings --mobile --offline-check --route-kind=settings
```

For an exact comparison, check out the approved base and candidate in separate
clean trees using the same lockfile, Node, pnpm, Chrome, OS, and compression
implementation. Build each once, run each measurement invocation with its own
fresh profile, and retain every JSON result. `scriptTransferBytes` is the sum of
CDP `Network.loadingFinished.encodedDataLength` for first-party Script
responses; `loadedScriptSourceBytes` is the UTF-8 byte length of the exact
same-origin scripts reported by precise coverage. Raw/gzip totals must be
computed from that recorded first-navigation URL set against the matching
`apps/web/dist` files, using the same compressor and options for both trees.
Publish the asset URL list, raw outputs, tool versions, and aggregation script
with any future precise table.

## Project-relative file presentation

Filesystem authority and execution still use the exact validated absolute
Project root and source path. Presentation now converts only contained file
paths to project-relative forward-slash form. Paths outside the Project, across
Windows volumes, rooted without a volume, drive-relative, or containing
ambiguous traversal receive only a safe basename in ordinary visible, hover,
and assistive UI. The exact source value remains diagnostic data but is not
exposed through a hidden default tooltip or accessibility label.

Provider-authored artifact summaries are likewise not ordinary display labels:
the UI derives labels from the artifact kind plus the safely presented path.
PDF projections retain the exact source path only in `sourcePath`, and recorded
unified-diff headers are rewritten to the same safe display path. Raw summaries
and exact paths remain available only in explicit technical diagnostics and
filesystem authority.

The focused matrix covers Linux, macOS, Windows drive paths, mixed Windows
separators, root-relative and drive-relative rejection, UNC shares and
cross-share/server rejection, sibling-prefix containment, macOS case
sensitivity, Windows case folding, cross-volume rejection, and traversal
rejection. Packaging qualification also rejected absolute/escaping/dangling
links, verified the Debian artifact's internal relative link, and found no
`/home/phoenix` path in the production web bundle or packaged runtime/artifact
surfaces it scans. This is deliberately not a claim about every compiler output:
the server test build contains a literal `/home/phoenix` fixture in
`context-rollover-handoff.test.js`, which is not shipped or runtime-reachable.

## Browser consolidation decision

The existing browser route already has one coherent server operation switch,
but the provider surface separates seven capabilities whose lifecycle semantics
are materially distinct:

| Tool | Preserved behavior |
| --- | --- |
| `browser_open` | Run-owned private browser or explicitly lent Project browser; bounded snapshot |
| `browser_navigate` | http(s)-only navigation; fails under operator control |
| `browser_inspect` | bounded, redacted semantic snapshot |
| `browser_act` | click/fill/key; operator-control fence; fill redaction |
| `browser_screenshot` | exact-Run PNG artifact publication and late-output fence |
| `browser_take_control` | explicit control epoch transition |
| `browser_close` | private close or lent-Project-browser return without closing |

A benchmark-only single `ponderosa_browser` candidate preserved the same
operation fields and endpoint. Live `gpt-5.4-mini` low-effort selection fixtures
were isolated by process and compared with the current surface:

| Fixture set | Current tools | Single-tool candidate |
| --- | ---: | ---: |
| Initial nine operations | 7/9 | 7/9 |
| Two additional runs of navigate/inspect/screenshot/close | 6/8 | 5/8 |
| Combined | 13/17 (76.5%) | 12/17 (70.6%) |

The candidate failed the equal-or-better selection gate, with inconsistent
navigate and screenshot selection in the boundary reruns. Consolidation is
therefore rejected. The shipped provider surface keeps the seven current tools;
there is no generic adapter or legacy dual path. The benchmark now imports the
canonical production definitions, and its regression test proves that exact
array is supplied to the Adapter.

Reproduce one isolated selection fixture with:

```bash
pnpm --filter @ponderosa/core build
pnpm --filter @ponderosa/engines build
node tools/efficiency/measure-browser-tool-selection.mjs \
  --model=gpt-5.4-mini --surface=legacy --fixture=screenshot
node tools/efficiency/measure-browser-tool-selection.mjs \
  --model=gpt-5.4-mini --surface=consolidated --fixture=screenshot
```

## Validation

- Web tests: 26 files, 134 tests passed.
- Server tests: 8 files, 45 passed, 1 platform/process test skipped.
- Agent tests: 12 files, 33 tests passed.
- Efficiency harness tests cover the canonical browser Adapter surface, every
  offline false-positive class described above, and profile/process cleanup for
  browser startup, target discovery, socket setup, and measurement failures.
- Packaging qualification: 14 tests passed, including persistent PWA upgrade,
  canonical path, symlink portability, and Debian artifact checks.
- Production direct-link and offline checks passed on desktop and mobile.
- Production web and packaged runtime/artifact host-path scans passed; compiled
  test fixtures are outside that claim.
