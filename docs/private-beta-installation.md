# Private-beta installation and qualification

Ponderosa private-beta packages are release candidates until the exact
installer has passed installed-artifact qualification on its target operating
system. A successful cross-build or TypeScript build is not OS support.

## Target matrix

| Target | Installer | Current qualification gate |
| --- | --- | --- |
| Ubuntu 24.04 x64 | `.deb` | Native install, bundled-runtime, native dependency, schema, removal, and data-preservation qualification |
| macOS 14+ Apple Silicon | `.dmg` containing a `.app` | Native Apple Silicon qualification, complete retained-descriptor file authority, Gatekeeper structure, and sleep/wake restart |
| Windows 11 x64 | User-level Inno Setup `.exe` | Native Windows 11 qualification, retained-handle reparse-safe file authority, and Job Object descendant teardown |

The build manifest records the exact Git commit, release channel, target,
launch-baseline schema SHA-256, bundled Node version and executable SHA-256,
Node modules ABI, and Node-API ABI. All three distributable artifacts for a
release candidate must contain the same exact commit.

## Installation

Ubuntu:

```bash
sudo apt install ./Ponderosa-<version>-linux-x64.deb
ponderosa-beta
```

macOS:

1. Open the `.dmg`.
2. Copy **Ponderosa Beta.app** to Applications.
3. Open the application.

When a newly installed package opens while a different Ponderosa Server build
is still running, the launcher identifies both builds and asks whether to
restart. Approving the restart gracefully stops the old server, starts the
installed build, and preserves Ponderosa data and selected Project folders.
Choosing **Not Now** leaves the existing server running and opens it normally.

Windows:

1. Run the `.exe` as the intended user.
2. Use the **Ponderosa Beta** Start-menu shortcut.

The Windows installer requests lowest privileges and installs below
`LocalAppData`. The Debian package uses ordinary package-manager authority to
install application bytes below `/opt`; the application itself runs as the
desktop user.

## Provider subscription login

Ponderosa does not accept provider API keys and does not store provider
credentials. Install and sign in to Codex or Claude Code using that provider's
own subscription-backed CLI before starting Agent work:

```bash
codex login
# or
claude auth login
```

Doctor reports executable discovery without launching provider commands.
After Ponderosa starts, the server's contained engine status verifies provider
login and subscription availability. A missing provider login is distinct from
a host-safety failure: provider unavailability prevents real Runs, while
missing filesystem or process authority prevents all durable intake.

## Unsigned private builds

Installer metadata next to every artifact records signing and notarization
state. Unless the release operator supplies environment-backed signing
configuration:

- macOS may quarantine the app and Gatekeeper may block first launch;
- Windows SmartScreen may warn or block first launch;
- Ubuntu reports an unsigned private-beta package.

Never bypass an OS warning for an artifact whose checksum and source commit you
cannot verify. Signing identities, certificates, passwords, tokens, provider
profiles, and notarization credentials are not included in Ponderosa artifacts.

## Data and runtime locations

| Platform | Ponderosa data | Application files |
| --- | --- | --- |
| Ubuntu | `$XDG_DATA_HOME/ponderosa-beta`, or `~/.local/share/ponderosa-beta` | `/opt/ponderosa-beta` |
| macOS | `~/Library/Application Support/Ponderosa Beta` | `Ponderosa Beta.app` |
| Windows | `%LOCALAPPDATA%\\Ponderosa Beta` | `%LOCALAPPDATA%\\Programs\\Ponderosa Beta` |

Selected Project source folders remain in their original host locations.
Ponderosa Project deletion and installer removal must never delete those
folders.

## Diagnostics and recovery

Run:

```bash
ponderosa doctor
ponderosa diagnostics
ponderosa status
ponderosa restart
```

On Windows use `ponderosa.cmd` from the installation directory when diagnosing
outside the Start menu.

Diagnostics include build identity, Doctor results, safe launcher state,
non-secret executable paths, and log metadata. They exclude control tokens,
browser bootstrap and session tokens, provider credentials, OAuth material,
environment secrets, raw logs, `.env` contents, Project file contents, message
bodies, and artifact bytes.

If startup state is stale, the launcher authenticates the recorded loopback
server before repairing it. It refuses to discard state for a still-live
unproven process. Collect diagnostics before manual recovery.

## Uninstall

- Ubuntu: `sudo apt remove ponderosa-beta`
- macOS: remove **Ponderosa Beta.app**
- Windows: uninstall **Ponderosa Beta** from Installed apps

Uninstall removes application bytes only. It preserves Ponderosa data and every
selected Project source folder. Delete preserved Ponderosa data manually only
after verifying no recovery or rollback is needed.

## Known private-beta limits

- Provider-authenticated Codex and Claude Runs are a manual release-candidate
  gate when CI has no subscription login.
- The macOS retained-root Project and managed-artifact implementation is a
  release candidate until publish/read/repair and adversarial ancestor-swap
  checks pass on Apple Silicon macOS 14+.
- The Windows retained-handle Project and managed-artifact implementation is a
  release candidate until reparse-point rejection and Windows 11 Job Object
  teardown pass on native Windows 11.
- GitHub-hosted Windows runners build on Windows Server, not Windows 11. A
  native Windows 11 machine remains the final OS gate.
- Unsigned artifacts are private test artifacts and carry the warnings above.

Installed qualification deliberately keeps `releaseQualified=false` unless
`PONDEROSA_NATIVE_ADVERSARIAL_FS_REPORT` names a JSON report for the exact
commit, platform, and architecture. That report must record passing root and
ancestor replacement, mount or volume, link or reparse, collision and
durability, batch rollback, production-route, and bounded-cancellation checks.
An environment flag without those recorded results cannot qualify a release.
