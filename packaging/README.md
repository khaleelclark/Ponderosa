# Private-beta packaging

Installation, data locations, authentication, diagnostics, uninstall behavior,
OS warnings, and qualification gates are documented in
[`docs/private-beta-installation.md`](../docs/private-beta-installation.md).

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
pnpm beta:node
pnpm beta:bundle -- --version 0.1.0-beta.2 --channel beta
pnpm beta:verify
```

`beta:node` downloads the target-native official Node archive, verifies it
against the release `SHASUMS256.txt`, and stages only the runtime executable.
The bundle contains its own Node runtime, production server dependencies, web
assets, the launch-baseline schema, launcher, build manifest, and a maintained
native qualification payload. It does not
contain Codex, Claude Code, provider credentials, Projects, or user data.

Bundles are assembled and qualified on their target operating system and
architecture. The build executes the proposed bundled Node binary, requires
Node 22, and rejects target metadata that does not match that runtime.
`beta:verify` loads and exercises `better-sqlite3` and `sharp` from the deployed
bundle, creates a database from the bundled launch baseline, and checks launcher
identity. Static cross-assembly is never labeled as verified.

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

Signing and notarization are optional release operations. Set
`PONDEROSA_MACOS_SIGN_IDENTITY` and, for notarization, a preconfigured
`PONDEROSA_MACOS_NOTARY_PROFILE`. Windows certificate-store signing uses
`PONDEROSA_WINDOWS_CERT_SHA1` with optional `PONDEROSA_SIGNTOOL` and
`PONDEROSA_WINDOWS_TIMESTAMP_URL`. Private-beta unsigned builds must disclose
their operating-system warning; credentials never belong in the repository,
workflow arguments, logs, or build manifest.

## Qualification state

The package architecture and assembly recipes cover all three operating
systems, but qualification remains intentionally fail-closed:

- Ubuntu/Linux: the self-contained bundle, launcher lifecycle, and `.deb`
  artifact are exercised on the Linux build host. AppImage production still
  requires a pinned `appimagetool` on the release host.
- macOS: the DMG recipe must be built on Apple Silicon and pass Gatekeeper,
  browser-bootstrap, process-group, provider, and restart checks before
  distribution.
- Windows: the native Job Object supervisor and retained-handle/reparse-safe
  Project and managed-artifact authority are implemented, but the EXE must
  still be built and exercised on Windows 11. Distribution remains blocked
  until the filesystem authority and nested provider/helper trees pass
  qualification on the exact artifact.

Do not weaken Doctor to turn an unqualified artifact green. Add the missing
native filesystem evidence at the platform boundary, then qualify the exact
artifact and its complete process trees.

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
