# Q02 / Q06 qualification, 19 October 2026

This is a scoped qualification record, not a platform support promise. New repair PRs remain unmerged. The disposable Pine sandbox integrates those PRs for testing; its settings and data do not define product behavior.

## Current source and interaction evidence

Review base: `a70dd5b41201d3b3d3a6cad9475be07d1ddceb61`. Linux sandbox before this PR: `3471e4c90990110f03cd998a3f2515cef915818a` (Node 24.16.0). That cumulative build passed 349 checks, with 21 expected opt-in skips, and installed native SQLite verification. It includes unmerged repairs; it is not the published installer.

A real browser test typed `Q02-ABCDE` in an existing idle Agent composer, moved left twice, received an Agent rename through the canonical API/SSE, then inserted `x` without refocusing. Result: `Q02-ABCxDE`. The test draft was cleared, the owned Agent title restored, and the original Chat draft preserved.

That test also reproduced a stale Agent header: the sidebar received the rename while the open Agent header and document title retained the old name. Project metadata events refreshed rosters but omitted Agent detail queries. This PR uses the existing Agent detail query prefix in the same invalidation branch. Ordinary project `used` events retain their existing behavior; hidden-page query policy remains shared with the other invalidations.

| Area | Evidence and remaining limits |
| --- | --- |
| Desktop caret and metadata | Real native typing/SSE test above; header refresh rechecked after deployment. Long title exercised in the sidebar. |
| Cached Home refresh | Existing real React Query/SSR regression checks retain cached cards, disclose refresh failure, and recover. |
| Attachments, routing, draft recovery | Existing 8 maintained checks cover archive bytes, routing, transcript export, and recovery edits. These do not qualify physical mobile file pickers. |
| Narrow layouts | Requested 390×844 and 1440×900 overrides did not produce those CSS dimensions (observed 1422×800 and 1595×1460). Override reset. No 390px/320px acceptance claimed. |
| Android / IME / Activity scrolling | Physical keyboard composition, mobile selection, installed PWA/offline upgrade, and follow-latest behavior remain unqualified. Source guards alone are insufficient. |
| Other historical interaction requests | New Chat initialization, imports, all header actions, navigation and slow-send behavior still need a recorded physical desktop/mobile matrix. Prior automated checks are narrower evidence. |

## Published assets are separate evidence

Official release: [v1.0.0-beta.1](https://github.com/khaleelclark/Ponderosa/releases/tag/v1.0.0-beta.1), published 16 October 2026 at 06:50:44 UTC. GitHub currently marks it `prerelease: false`, despite its beta name. No release settings were changed.

The annotated tag points to documentation commit `df599529b8296551ca01fb881bab473afcc1407d`. Its release body identifies application build `11799668b5496c578c67a46f6a5fe57952ebc56b` and guide build `dc334a2f`. It also discloses reused Windows native inputs and a historical SDK hash limitation. These are not interchangeable source identities. The tag is unsigned.

The downloaded `SHA256SUMS.txt` matched GitHub's digest (`5a4c63dcbe2d321f691d515d3a367f7af5bcd0a393dbc0f7f7903ae5f8fb8ec8`). Its five entries matched the release API asset digests:

| Asset suffix | SHA-256 |
| --- | --- |
| darwin-arm64.dmg | `d80b415467eed2521179b225dbc25b46760a79b066662faf75f1bfcf3a7da956` |
| linux-x64.AppImage | `840548170646cd93e47f4a5aaa8f4792f3fbb971dbb80859b39510632a60c94e` |
| linux-x64.deb | `5a52feadab4db656946e33f9ccd9c73150a24d5e0dffa6d7dc6f3e83798a1fac` |
| win32-x64.exe | `a372f56d933f43bda38575368f05cc7f4964c0b40ffc27c0eb04fabeaea0fbf4` |
| User-Guide.zip | `c8f09fe34ba5f685a66c9db8dd375c5a108e5a7ba5bca11840db678a065026c0` |

Installer payloads were not downloaded, independently rehashed, installed or upgraded in this pass. Historical installation receipts in `docs/release-candidate.md` do not establish acceptance of these exact assets. A paired macOS READY receipt proving which Desktop/Brew CLI binary the GUI selected was not located; merely finding a newer executable would not prove that pairing.

## Open release decisions

The existing native beta workflow runs on tags/manual dispatch; production packaging requires its release environment and signing configuration. The current unfiltered `gh run list --limit 12` inventory returned no runs. That is an inventory observation, not a passing CI result. No workflow was dispatched and no signing credentials or release settings were changed.

Before broader distribution, the release owner must reconcile beta/prerelease classification, exact source and reused-input provenance, signing/notarization policy, and fresh per-platform launch/upgrade/provider/browser receipts for the exact assets. These remain Q06 acceptance work; this PR does not mark them complete or revive superseded account-wide model limitations.
