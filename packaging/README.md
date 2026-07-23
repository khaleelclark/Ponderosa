# Private-beta packaging

Ponderosa keeps one application implementation across operating systems:

```text
platform installer
  -> bundled Node runtime
  -> TypeScript launcher
  -> existing Fastify server and web application
```

The initial qualification matrix is macOS 14+ on Apple Silicon, Windows 11 on
x64, and Ubuntu 24.04 on x64. Those are release-test targets, not application
restrictions. Paths, browser opening, provider discovery, executable naming, and
installer assembly live behind narrow platform boundaries.

## Build a self-contained application bundle

On the target operating system:

```bash
pnpm install --frozen-lockfile
pnpm beta:bundle -- --version 3.5.0-beta.1 --channel beta
pnpm beta:verify
```

The bundle contains its own Node runtime, production server dependencies, web
assets, migrations, launcher, build manifest, and starter pack. It does not
contain Codex, Claude Code, provider credentials, Projects, or user data.

Cross-target assembly requires a target-native Node binary passed with `--node`.
Native dependencies such as `better-sqlite3` and `sharp` must still be installed
and qualified on the target operating system and architecture. Do not label a
cross-assembled directory as a verified installer.

## Package formats

```bash
# macOS
pnpm beta:package -- --format dmg

# Ubuntu/Linux
pnpm beta:package -- --format appimage
pnpm beta:package -- --format deb

# Windows
pnpm beta:package -- --format exe
```

The platform host must provide its packaging tool:

- macOS: `hdiutil` (included with macOS)
- Windows: Inno Setup 6 (`ISCC.exe`)
- Linux AppImage: `appimagetool`
- Ubuntu `.deb`: `dpkg-deb`

Signing and notarization are release operations. Private-beta unsigned builds
must disclose their operating-system warning; credentials never belong in the
repository or build manifest.

## Qualification state

The package architecture and assembly recipes cover all three operating
systems, but qualification remains intentionally fail-closed:

- Ubuntu/Linux: the self-contained bundle, launcher lifecycle, and `.deb`
  artifact are exercised on the Linux build host. AppImage production still
  requires a pinned `appimagetool` on the release host.
- macOS: the DMG recipe must be built on Apple Silicon and pass Gatekeeper,
  browser-bootstrap, process-group, provider, and restart checks before
  distribution.
- Windows: the EXE recipe must be built on Windows 11. Doctor deliberately
  rejects Agent work until a narrow native Job Object supervisor provides
  observed process-tree containment; a root-process-only package is not a
  qualified Windows beta.

Do not weaken Doctor to turn an unqualified artifact green. Add the missing
native containment at the platform boundary, then qualify the exact artifact.

## Installed security boundary

Installed launch uses one-time fragment bootstrap:

1. The launcher authenticates to a loopback-only control endpoint with a
   private file-scoped secret.
2. The server creates a one-minute, one-use browser credential.
3. The credential stays in the URL fragment and is posted from a local
   bootstrap page.
4. The server consumes it, issues an HttpOnly SameSite session, and the browser
   replaces the URL with `/`.

The launcher secret is never sent to the browser. Bootstrap and browser session
credentials are excluded from diagnostics. Closing the browser does not stop
the server.
