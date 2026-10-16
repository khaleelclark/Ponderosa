# Installation checks — 15 October 2026

These results cover disposable data and installations. Normal installations,
provider profiles and existing installer files were preserved. No release was
published or deployed by this work.

## Packages and data used

New local packages were built from `b80f00249baa45bf326cdbffcccd49e4a28ff392`
as `1.0.0-beta.1`, channel `beta`, using native Node 24.16.0 on each build host.
The older package for the replacement checks was the retained `1.0.0` build at
`eebdf452831612cd498605d2fa1c809e00670e94`. These identities describe the tested
artifacts, not a published release or tag.

| Local artifact | SHA-256 |
| --- | --- |
| `Ponderosa-1.0.0-beta.1-darwin-arm64.dmg` | `a8cd312464e00c9484486c8bf10686f571cb1edab34855db32e4078da6adc98e` |
| `Ponderosa-1.0.0-beta.1-linux-x64.deb` | `99cf5c2dc37284635bd4c5f1108150420478c1fd7b82fbf49b6c54c43f5f45d3` |
| `Ponderosa-1.0.0-beta.1-linux-x64.AppImage` | `b57b18ae48b44af51cb73a97ca05e4b94a74f9a9710e012e94db943c606e2ebd` |
| `Ponderosa-1.0.0-beta.1-win32-x64.exe` | `1ed3129b19a1ce205d71eccd8a66c8d55f7216920cb865c9898437eb327fc760` |

The macOS and Linux fixtures used the maintained controlled provider adapter
against the real packaged server. They created one Chat and Agent, four completed
Runs, shared and private messages, an uploaded attachment, a published result,
Chat and global instructions, a starred Chat, launcher configuration and a separate
external working folder. No live Codex or Claude requests were needed.

Verification compared canonical Chat/Agent/message/Run IDs, saved instructions
and settings, the workspace identity, and exact attachment/result/external-file
hashes. It also opened the packaged launcher over HTTP and downloaded the saved
attachment and result after upgrade and each restore. Every started daemon was
stopped and its exit observed before copying or removing application files.

## Results

| Check | macOS 27, Apple Silicon | Ubuntu 26.04.1, x64 | Windows 11, x64 |
| --- | --- | --- | --- |
| New package build | DMG passed | DEB and AppImage passed | EXE passed |
| Replace older application, retain selected data root | Passed | Passed through isolated `dpkg` installation/upgrade | Passed with explicit original root |
| Stopped whole-root backup plus external working folder | Passed, copies verified byte for byte | Passed, copies verified byte for byte | Passed, launcher configuration and external folder included |
| Restore complete folders to original disposable locations, then reopen | Passed | Passed | Passed, exact beta.1 reopened restored folders |
| Packaged offline application-data backup/restore | Passed with external folder included | Passed with external folder included | Excluding external folders passed; including them backed up successfully but failed during restore in both versions |
| Remove application, preserve data/settings/external files | Passed | DEB and AppImage-copy removal passed | Old/new uninstallers passed preservation checks |

### macOS

The older DMG application was copied into a disposable Applications directory,
then replaced at the same location with the new DMG application. Both versions
opened the same explicitly selected launcher root. The new Engine desktop window
and its server launched with a separate Electron profile; version and revision
matched the installed manifest. Application removal deleted only the stopped
disposable `.app`; launcher data, settings and external files remained byte-identical.

### Linux DEB

The real package manager installed the old DEB, installed the new DEB over it,
and removed the package. It used a dedicated `dpkg --root` and package database,
so the host's normal package registration and application paths were unchanged.
The packaged launcher/server ran from the installed files. Removal deleted the
application and wrapper while preserving the complete disposable launcher root
and external working folder. This check did not exercise a Linux desktop menu
or a system-wide installation.

An unprivileged host `needrestart` hook attempted to touch its `/run` marker and
was denied; the isolated install, upgrade and removal completed successfully.
No host security or service configuration was changed.

### AppImage

The maintained recipe produced
`Ponderosa-1.0.0-beta.1-linux-x64.AppImage`. It was built with upstream
[appimagetool 1.9.1](https://github.com/AppImage/appimagetool/releases/tag/1.9.1),
whose downloaded SHA-256 matched the upstream release metadata.

FUSE mounting succeeded. All 11 maintained installed-bundle checks passed from
the mounted artifact. The actual bundled launcher opened the restored Chat,
settings and completed Runs and downloaded the correct attachment/result bytes.
Deleting a byte-identical disposable copy of the AppImage left saved data and
external files unchanged; the original built artifact was retained.

The exact extracted AppImage payload also passed all 11 installed-bundle checks
in an Ubuntu 24.04 userspace container on pine, with network access disabled, a
read-only application mount and disposable output. That checks the bundled Node,
native storage and other maintained runtime checks against Ubuntu 24.04 libraries;
it does not exercise that distribution's desktop or kernel. The container was
removed after the check.

**Desktop launch failed.** Running the actual AppImage under Xvfb with fresh
launcher and Electron profiles aborted before server startup. Chromium reported
that `chrome-sandbox` must be owned by root with mode `4755`; the image contains
it as root-owned mode `0755`. The host's unprivileged-user-namespace restrictions
were enabled. No sandbox flag or host-policy workaround was used. Mounting and
backend checks do not establish a working desktop launch. This candidate needs
that failure resolved and retested before its normal opening instructions can
be treated as working on the checked host.

### Windows

The actual old and new Inno installers ran into an explicitly disposable install
directory. After separate human authorization, the normal user's AppId registration
and installer-owned shortcuts were backed up before testing and restored afterward.
The sequence covered old install, old uninstall, old reinstall, upgrade to beta.1
and beta.1 uninstall. Application files were removed from the disposable location;
data, settings, external files and backup sentinels survived.

Both actual installed payloads loaded their native libraries and started with
security settings unchanged. An earlier compiler-input/source-path probe was
blocked by Application Control; that did not reproduce in the later installed
payloads. The result does not establish why the policy treated those probes
differently.

The saved-content checks verified the canonical message ID and authored text,
saved Chat display, exact uploaded attachment and managed-artifact downloads,
and custom settings. Beta.1 reopened that saved content with the original root
explicitly selected. Both versions backed up and restored application data with
external folders excluded, while keeping the original working folder available.
A separate complete-folder check then backed up the stopped launcher root,
including launcher configuration, and the external working folder. Originals were
retained separately; copies were restored to their original disposable paths.
The exact installed beta.1 reopened them and matched saved Chat/message IDs,
attachment and artifact bytes, settings, launcher configuration and external
files. Shutdown was observed; uninstall preserved the restored folders.

Two observed outcomes need to remain clear:

- **External-folder restore failed.** With `--external-projects copy`, backup
  succeeded but the shipped restore tool rejected its manifest with
  `invalid or duplicate external Project backup binding`. Both the old and
  beta.1 installed payloads reproduced it. Application-data-only restore passed;
  do not rely on this tool's combined external-folder restore on Windows until
  repaired and retested. Keep separate working-folder copies.
- **Old default-root discovery failed.** A fresh default-root fixture created
  through the real old launcher served its saved Chat. Beta.1's default selected
  the new `Ponderosa` folder and returned 404 for that Chat. The `Ponderosa Beta`
  data remained intact. Explicit original-root reopening passed. The update
  instructions therefore require selecting that original root when moving from
  a private build; they do not claim automatic discovery or migration.

The completed installer cycle preserved normal application/data files, retained
installers and provider sign-in files. Normal registration values, types and ACLs
and both installer-owned shortcuts were restored and checked. No owned daemon,
listener or disposable application installation remained after that cycle.

## How to interpret the upgrade result

The passing replacement checks retain the original launcher root explicitly.
Older private builds used `Ponderosa Beta` / `ponderosa-beta`; the new default is
`Ponderosa` / `ponderosa`. That rename does not move or delete existing data.
Select the original root when reopening it. No automatic data migration was
introduced by these checks.

Both complete-folder restore and the separately packaged offline restore tool
were exercised. Complete-folder restore includes launcher configuration; the
offline tool backs up application data and, when requested, external working
folders. It is not a substitute for saving launcher configuration. On macOS and Linux, the offline
tool also refused an existing restore destination rather than overwriting it.

These tests exercise the current storage format and the exact package pair above.
They do not establish arbitrary historical-format migration or downgrade behavior.
Other OS versions and architectures were not excluded by these observations.

Use the [user guide](user-guide.md#back-up-and-restore) for the tested folder-copy
procedure. Keep backups separate from the active root and retain originals until
the restored records and files have been checked.
