# Public beta and current qualification — 20 October 2026

The [published `v0.1.0` release](https://github.com/khaleelclark/Ponderosa/releases/tag/v0.1.0)
contains macOS arm64 DMG, Windows x64 EXE, Linux x64 DEB and AppImage, an offline
guide and checksums. It was published on 16 October 2026 as `v1.0.0-beta.1` and
renamed to `v0.1.0` at the release owner's request on 20 October. Its original
installer filenames, embedded build identities and hashes remain unchanged.
The next installer version is **0.1.1**, retaining channel **beta**. For 0.x
releases, the root package version is the exact installer version; advance it
before cutting another release. GitHub's existing `prerelease: false`
classification is unchanged.

## Build and verification entry points

Use Node 24 and pnpm 11.10.0. See the root [package scripts](../package.json):

- `pnpm verify`: build, typecheck and maintained tests.
- `pnpm beta:node`: prepare the checksummed official native Node distribution.
- `pnpm beta:bundle`: build a clean exact-source native bundle.
- `pnpm beta:verify --bundle <bundle>`: verify that bundle on its native platform.
- `pnpm beta:package`: assemble the platform package using [package-beta.mjs](../packaging/package-beta.mjs).

The [bundle builder](../packaging/build-beta-bundle.mjs) and
[installed verifier](../packaging/qualification/verify-installed-bundle.mjs)
enforce runtime, native ABI, notices, schema and image-isolation checks.
Building a package is separate from testing its installation or publishing it.

## Evidence and limits

| Source / artifact | Observed qualification | Limits |
| --- | --- | --- |
| F03 `2cdfff4508a0f75ae2c436f7fc53339c6b3f8ff7`, [PR #8](https://github.com/khaleelclark/Ponderosa/pull/8) | Proxy shutdown controls on macOS/Linux; Pine suite 244 passed, 21 skipped; active-stream proxy restart observed | These results do not qualify a Windows installation. |
| F04 `950219f1d49a8445c19ac93dfcdd2e32a3d45709`, [PR #9](https://github.com/khaleelclark/Ponderosa/pull/9) | Ubuntu 26.04.1 x64, Node 24.16.0, modules ABI 137 / N-API 10; 247 passed, 21 skipped; built bundle passed native verification with eight independent native images and ran in the existing Pine sandbox | Owned cache-corruption fixture only; published beta.1 assets were not changed or requalified. Mac source checks are separate from installed-package acceptance. |
| Master `a70dd5b41201d3b3d3a6cad9475be07d1ddceb61` | Merge of #8 and #9; its tree matches F04's qualified head | A matching tree is not a fresh installer acceptance run. |
| Current-source investigation at F04 head | Controlled failures reproduced remaining repair candidates; F12's old folder picker is removed and F15 decoding already exists | A provider-cleanup prompt-fence test was intermittent. The investigation is not an all-green qualification. |

F15 is reconciled as an existing fix: browser callers encode filenames once and
the [shared upload admission](../apps/server/src/attachment-upload-lifecycle.ts)
decodes once before Agent, Chat and draft handlers. The maintained
[encoding regression](../tests/files-results/attachment-filename.test.mjs) covers
Unicode, literal percent sequences, malformed encodings and recovery; the
[real-route regression](../tests/files-results/files.test.mjs) covers stored names
and byte-exact downloads after restart. No second codec is needed.

The [15 October installation checks](installation-checks.md) and
[14 October candidate selection](release-candidate.md) retain their original
source heads, artifact hashes, failures and platform limits. They are historical
evidence, not passes for current source or every publicly downloadable file.

Normal-profile installer upgrades and recovery on supported OS versions,
Windows/macOS acceptance of current packages, physical speech/accessibility,
signing/notarization and the [source-notice questions](../packaging/notices/SOURCE-REFERENCES.md)
remain separate qualification or release-owner work. Local receipts and hosted
CI are distinct; this index does not claim an ordinary PR CI run or release approval.
