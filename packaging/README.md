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
pnpm beta:cut
pnpm beta:node
pnpm beta:bundle -- --channel beta
pnpm beta:verify
```

`beta:cut` refreshes remote release state, requires the current clean commit to
be the exact `origin/master` tip, calculates the next beta number from canonical
annotated release tags, creates the tag, and pushes it. Run it once for a
multi-platform beta; every target-machine build of that tag then receives the
same version, and pushing the tag starts the native artifact workflow.
Re-running a tagged commit preserves its exact version. Manually dispatch that
workflow only from a beta tag. Use an explicit `--version` on `beta:bundle` only
to reproduce historical evidence.
The root package version declares the release line (`0.1.0`); beta sequence
numbers are release metadata and never require a source-only version bump.

`beta:node` downloads the target-native official Node archive, verifies it
against the release `SHASUMS256.txt`, and stages only the runtime executable.
The bundle contains its own Node runtime, production server dependencies, web
assets, the launch-baseline schema, launcher, build manifest, and a maintained
native qualification payload. It does not
contain Codex, Claude Code, provider credentials, Projects, or user data.

Bundles are assembled and qualified on their target operating system and
architecture. The build executes the proposed bundled Node binary, requires
Node 24, and rejects target metadata that does not match that runtime.
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

Signing and notarization are optional for private-beta artifacts. Set
`PONDEROSA_MACOS_SIGN_IDENTITY` and, for notarization, a preconfigured
`PONDEROSA_MACOS_NOTARY_PROFILE`. Windows certificate-store signing uses
`PONDEROSA_WINDOWS_CERT_SHA1` with optional `PONDEROSA_SIGNTOOL` and
`PONDEROSA_WINDOWS_TIMESTAMP_URL`. Private-beta unsigned builds must disclose
their operating-system warning; credentials never belong in the repository,
workflow arguments, logs, or build manifest.

Production publication is currently limited to the Linux x64 private-beta
target. The separate, manually approved workflow accepts only an annotated
stable tag at the exact `origin/master` commit, runs full verification and
installed-provider qualification on a dedicated Linux host, and creates
GitHub/Sigstore provenance for the qualified `.deb`. Missing providers, target
hosts, or approval fail closed; private-beta jobs cannot publish a production
release. macOS and Windows recipes remain development artifacts and are not
supported production targets.

## Qualification state

The package architecture and assembly recipes cover all three operating
systems, but only Linux x64 is currently eligible for production:

- Ubuntu/Linux: the self-contained bundle, launcher lifecycle, and `.deb`
  artifact are exercised on the Linux build host. AppImage production still
  requires a pinned `appimagetool` on the release host.
- macOS (not production-supported): the DMG recipe must be built on Apple Silicon and pass Gatekeeper,
  browser-bootstrap, process-group, provider, and restart checks before
  distribution. macOS cannot use Linux's traversable `/proc/self/fd` data root:
  the private-beta daemon uses its atomic ownership lock while attachment,
  Project-file, and managed-artifact operations use the native secure-file
  authority. Full retained-root data-store protection remains a separate
  production gate.
- Windows (not production-supported): the data-store authority is not yet
  handle-relative/reparse-safe. The EXE must not be distributed until that
  native authority and the complete process trees pass Windows 11
  qualification on the exact installed artifact.

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
