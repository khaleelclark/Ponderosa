# 1.0 beta package selection

Historical candidate record. The versions and hashes below describe the retained
artifacts as built. New beta packages use `X.Y.Z-beta.N` (starting with
`1.0.0-beta.1`); see the [current build recipe](../packaging/README.md). This
record does not establish that new-format installers have been built or qualified.

Prepared October 14, 2026. These unpublished candidates use version **1.0.0**
inside Engine and short **1.0** download names. Runtime source and tests remain
frozen. The human-approved exception repackages the retained compiled bundles
with two release-metadata changes; it does not compile new application code.

## Package identity

| Platform target | Download name | Compiled application revision |
| --- | --- | --- |
| Windows 11 x64 | `Ponderosa-1.0-Windows-x64.exe` | `c32b4f96019da9232f1d7ecde913e6b9692a6b89` (Root 1) |
| macOS 14+ Apple Silicon | `Ponderosa-1.0-macOS-arm64.dmg` | `07ba58bc8a78b932d3587e307409b2581ccde4d3` (final1) |
| Ubuntu 24.04 x64 target | `Ponderosa-1.0-Linux-x64.deb` | `07ba58bc8a78b932d3587e307409b2581ccde4d3` (final1) |

The [machine-readable selection](release-candidate.json) records package byte
lengths, SHA-256 checksums, completed checks and pending results. Windows EXE assembly completed after the generated compiler recipe's
source path was shortened to a byte-identical retained payload; packaging options
were unchanged. The initial Inno path failures remain recorded. The original packages and qualification records remain preserved in
`historicalArtifacts`; their passes do not stand in for checks of the new files.

All portable-bundle files and symlink targets match the retained originals except:

- `build-manifest.json`: version `1.0.0`, channel `beta`.
- Generated `app/engine-desktop/package.json`: version `1.0.0`.

The native packager assembles a new Electron application and installer. Generated
metadata, archive integrity checksums and executable/package hashes can therefore
change. Short filenames are byte-identical copies of those new package outputs,
not a claim that the old installers have acquired a new internal version.

Source is retained in `khaleelclark/Legacy-Ponderosa`. The metadata/documentation
base is master `6c214dec74f58ecc51124f396c2c88b56b9fa78d`; it is distinct from the
compiled runtime revisions above. The common newer schema-line-ending fix at
`843a869a` (draft PR #708) is not included in the selected Windows Root 1 runtime.
Preserve that candidate's tests and evidence.

## Beta scope

Use fresh installations. Existing-profile upgrades and migrations remain outside
qualification; preserve existing data and settings. Codex is the approved provider
path. Claude qualification remains deferred. The internal browser is included;
local browser connection and extension pairing are deferred. Wiki and Automations
are excluded. Branches and Pinecone remain future features. No AppImage is selected.

The packages are unsigned; Mac is also unnotarized. A changed Windows executable
has a new fingerprint, so the old Root 1 launch result cannot establish acceptance
of the new executable on every protected computer. Signing, security settings,
normal-profile installation and publication are outside this repackaging step.

## Observed checks on the new packages

| Candidate | Completed | Limits |
| --- | --- | --- |
| Windows 1.0 | Compiler-input native checks 11/11; lifecycle 20/20 on retry. Fresh native Engine visibly showed `1.0.0 · beta`, Running/Ready on cold start and reopen, then both process trees exited after graceful quit. | Earlier lifecycle attempts failed at the long startup path, then passed 19/20 with Codex readiness unverified during compression; final unchanged retry passed 20/20. Checks used retained compiler input, not a normal installed-app upgrade. All 52 original receipts were imported with verified bytes/hashes; normal app/data/settings were unchanged. |
| Mac 1.0 | Actual new DMG-extracted native checks 12/12; lifecycle 21/21, `releaseQualified: true`. After human OS consent, four manual native GUI checks passed: cold start and same-profile reopen visibly Running/Ready and `1.0.0 · beta`, with both Quit Engine actions closing observed processes, port and state. | Two pre-consent GUI startup timeouts remain recorded. The post-consent automated GUI qualifier reached startup but failed at its separate CLI-stop command with a directory-ownership refusal. The human accepted this automated stop refusal as non-blocking after the successful manual GUI journey; the observed failure remains recorded. No owned payload processes remain. |
| Linux 1.0 | Actual new DEB-extracted native checks 11/11; lifecycle 20/20; launcher identity matches `1.0.0`. | Host is Ubuntu 26.04, not the Ubuntu 24.04 target, so `releaseQualified: false` remains. Native GUI not rechecked. |

Earlier real Codex attachment/text reads passed twice on each retained Mac/Linux
runtime. Those results are historical; they were not rerun for the metadata overlay.
The Windows fresh web Home/composer walkthrough remains unverified following
unavailable Chrome automation and automatic approval review's pre-execution
rejection of a disposable Edge launch. These are distinct from an OS launch verdict.
Normal-profile restore, upgrade and uninstall journeys remain unverified where no
exact-package observation exists. Disposable lifecycle restore is not a user-profile
upgrade check.

## Notices, sources and accompanying documentation

The prepared notice/source collection and concrete replacement instructions
already exist. Dependency declarations, the lockfile, notice assets and collector
are unchanged from the inspected source snapshot through both compiled revisions;
the two-file metadata overlay does not alter those inputs. Exact runtime source
archives and platform package identities are staged in the private release packet.
The existing [source-reference limits](../packaging/notices/SOURCE-REFERENCES.md)
remain recorded. Public recipient access is not established before publication;
this record does not certify a complete external Electron rebuild or modified
native-library replacement operation.

The revised README, user guide, HTML guide and this selection accompany the
packages as an addendum. Compiled web assets and their embedded older manuals
retain their original bytes under the runtime freeze. Source-package version
`1.0.0` records the release line; it does not change those compiled sources.

No merge, tag, publication, deployment, normal-profile install, signing purchase
or security-policy change is authorized by this record.
