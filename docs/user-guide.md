# Ponderosa installation and user guide

**Ponderosa v0.1.1 public beta.** [Public downloads](https://github.com/khaleelclark/Ponderosa/releases/tag/v0.1.1).
Start with the [README](../README.md). The [HTML learning
guide](learning/index.html) explains how agents, assignments and saved work fit together.

Ponderosa supports continuing work with agents, including research, coordination,
creative projects and software development. Linux, macOS and Windows are
beta platforms, and the internal browser is included. Local browser connection
and extension pairing are deferred beyond beta. Branches and Pinecone are future
features; Wiki and Automations are excluded.

Ponderosa is model agnostic with Codex and Claude Code. You can use either or configure
both; they use their own subscription sign-ins and do not have identical models,
effort settings or tool behavior.

## Before you install

You need your own computer or server, a modern web browser, and Codex CLI or Claude
Code installed and signed in on your machine with your subscription under the same 
account that runs Ponderosa Engine. If you access Ponderosa from another device, provider setup
belongs on the Engine host. Ponderosa does not accept provider API keys at this time.

Ponderosa packages include Node. Node and pnpm are needed only to build or develop
Ponderosa from source; a provider's installation method can have its own runtime
requirements. Git is optional for ordinary research and creative work. Internal
browsing requires Chrome or Chromium on the Engine host.

Agents use the host account's files and shell. A Chat working folder is not a
security sandbox. Self-hosting stores Ponderosa's records locally, while AI
requests still go to your selected provider. Begin with non-sensitive material.

## Download and install

Use the release attached to [khaleelclark/Ponderosa](https://github.com/khaleelclark/Ponderosa/releases). Its
release notes must identify the exact version, filenames, checksums or provenance,
signing status and platform limits. The first public beta, `v0.1.0`, was originally
labeled `v1.0.0-beta.1`. Engine and installer filenames show the release version.
Use the checksums and qualification results that accompany the actual download.

| Beta target | Current recipe | Installation path to check on the final package |
| --- | --- | --- |
| Ubuntu 24.04 x64 | `.deb` | Install the package, then open **Ponderosa Engine** from the application menu. |
| macOS 14+ on Apple Silicon | `.dmg` | Mount the disk image, copy **Ponderosa Engine.app** to Applications, then open it. |
| Windows 11 x64 | Installer `.exe` | Run the installer under your login account, then open **Ponderosa Engine** from the Start menu. The default destination is `%LOCALAPPDATA%\Programs\Ponderosa`. |

**Windows:** Smart App Control may block this unsigned beta from starting.
Edge may also warn that the download is uncommon. Verify its source and checksum
before deciding whether to keep it. Leave Windows security protections enabled.

**macOS:** This beta has an ad-hoc signature and is not notarized by Apple.
If blocked, use **System Settings → Privacy & Security → Open Anyway** for this app.

On Ubuntu, from the directory containing the download:

```sh
sudo apt install ./Ponderosa-0.1.1-linux-x64.deb
```

APT installs the package's required desktop libraries and browser-opening tools.
You still need a default web browser. Other current filenames are
`Ponderosa-0.1.1-darwin-arm64.dmg` and `Ponderosa-0.1.1-win32-x64.exe`.
This release does not include AppImage or Intel Mac packages.

Testing one OS or architecture does not exclude other platforms from beta scope.
See the check results for the exact packages and machines exercised.

## Open Ponderosa

1. Open **Ponderosa Engine** from the installed application entry.
2. Keep Engine running. It starts the local service and opens the web app in your
   default browser. Choose **Open Ponderosa** to reopen it.
3. Check Engine's status and **Work intake**. It also shows the version, revision,
   data location, active Agent Runs, and **Server** and **Errors** logs.

You work in the web app; Engine manages its service. Closing a web tab leaves the
service running. Closing Engine's window hides it; **Quit Engine** stops it and
can interrupt work. Files already written are not undone.

If Windows reports that an earlier process Job cannot be confirmed stopped and
asks for a reboot, save your other work, restart Windows, then open Engine again.
Ponderosa preserves its data and uses the new kernel boot identity to verify that
the old Job ended before allowing a replacement service.

If a manually typed address has an authentication problem, open the app through
Engine. Keep its bootstrap address private. Access from another device requires
separate [host and network setup](../deploy/README.md).

## Provider setup

Install and sign in to at least one provider on the Engine host, under the same
OS account that runs Engine. This happens in the provider CLI, not an in-app
Ponderosa sign-in form. Follow the subscription route; API keys and provider
Console billing are not Ponderosa authentication methods.

The commands below follow the official [Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli),
[Codex installer reference](https://learn.chatgpt.com/docs/config-file/environment-variables)
and [Claude Code quickstart](https://code.claude.com/docs/en/quickstart).
Run only the installer for the provider you want. Open a new terminal afterward
so it picks up PATH changes, then quit and reopen Engine if it was already running.
On Windows, use native Windows CLIs with the Windows Engine; a CLI installed only
inside WSL is a separate environment.

### Sign in to Codex

On macOS or Linux:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://chatgpt.com/codex/install.ps1 | iex
```

Then, in a new terminal on that host:

```text
codex --version
codex login
```

Complete **Sign in with ChatGPT** using your subscription. The [official login
reference](https://learn.chatgpt.com/docs/cli/reference#codex-login) describes the
browser flow and device-auth option for a host without a browser.

### Sign in to Claude

On macOS or Linux:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://claude.ai/install.ps1 | iex
```

WinGet is another supported Windows installation method:

```powershell
winget install Anthropic.ClaudeCode
```

Then open a new terminal and run:

```text
claude --version
claude
```

Follow the browser sign-in prompts for your Claude subscription. If you need to
sign in again, enter `/login` inside Claude Code. Exit the CLI after setup; Engine
starts its own provider sessions for tasks. Do not paste credentials into Ponderosa.

### Choose provider, model and effort

Open **Provider Settings** in the web app and enable the provider you installed.
If it needs attention, use **Recheck sign-in** where offered. In **AI provider
status**, read the detail. **Sign-in information found** does not prove the account
can run work. **Test Access**, when offered, makes a small live provider request
and can consume subscription usage; it is separate from rechecking sign-in.

In a New Chat composer, open the model control to choose the provider (**Engine**),
**Model**, and **Reasoning** effort where available. For an existing Agent, the
provider can be fixed while model/effort controls remain available. Use the
choices shown for that provider and model. Higher effort can use more time and
subscription allowance; identical labels do not promise identical behavior.
Provider-installed tools, skills and connectors also depend on host configuration.

If a provider remains unavailable, begin with the Engine and web status/log steps
in [recovery](#recover-without-losing-your-work). Advanced executable-path setup is
[below](#provider-executable-paths).

## Finish your first task

A **Chat** holds a conversation, agents, instructions and a working folder.
An **Agent** is a continuing worker identity. A **Run** is one turn of work.
You can start an ordinary Chat without first creating a team.

1. Choose **New Chat** from Home or the sidebar. The current flow opens a Chat
   with a managed working folder. Open **Provider settings** if no provider is configured.
2. Check the composer controls and choose Codex or Claude Code, then an available
   model and **Reasoning** setting if offered. Keeping the defaults is fine.
3. Send: “Write a three-item checklist for planning a picnic. Reply in this
   Chat. Do not browse or change files.”
4. Read the checklist. A saved message or completed Run alone does not establish
   that the reply answers your request.
5. Ask: “Make the checklist suitable for rainy weather.” Read the follow-up.
6. Close the web tab, reopen through **Open Ponderosa**, and return to the saved Chat.

Shared Chat contains authored messages. Inspect tools and execution details in
Agent views such as **Work log**.

### Editing and input

Rename a Chat from its actions menu. **Enter** saves; **Cancel** leaves the name
unchanged. The shared rename dialog ignores Enter while an IME composition is active.

Pasting multiline text keeps the complete text in the draft until you submit it.
After you begin interacting with the next draft, background replies do not add a
reply destination to it. Existing and explicitly selected destinations remain.
On desktop, **Enter** sends and **Shift+Enter** inserts a newline. On Android and
iOS, **Return** inserts a newline; use **Send** to submit.

Global Agent instructions accept up to 100,000 UTF-16 code units. An oversized save
shows an error and leaves saved instructions unchanged; shorten the unsaved draft
before saving again. Immediate settings errors stay visible until dismissed or that
setting saves successfully. Saving a different setting does not clear the failure,
including another notification toggle, provider’s saved model, or saved reasoning
control.

Browser voice uses the browser's read-aloud voice and the device's speech recognition;
availability varies by browser and device. Speaking speed is adjustable in settings.
Token Usage shows provider-reported counts, with cached input separate where available;
provider account limits appear in Provider usage. These counts are not cost estimates.
The Engine's truncated log label reports the size of the returned tail, not the full log.

### Attachments and saved results

Attach files through the composer or use `@` references to available working-folder
files. The current defaults allow up to 20 attachments per message, 80 MiB per
file and 80 MiB total per message. The composer shows the applicable limits;
remaining storage allowance can also prevent an upload. Wait for uploads to
finish and resolve notices before sending. Accepted storage does not mean every
provider can interpret every file format.

Ask the Agent to identify the material it used. Review generated deliverables in
**Files & Results**, open or download the intended file, and save copies you need.
An **artifact** is a file captured into Ponderosa's managed storage; it has a
different lifetime from an uploaded input or a file in your working folder.

### Queue, steer and retry

While a response is active, **Queue message** saves follow-up work for afterward.
**Steer** sends guidance to the active response where supported; it does not undo
commands already run. Queued messages can offer **Steer now**, edit and delete
controls. Read the receipt to see whether work is queued, started or still
unconfirmed. Provider capacity, account access and host resources can keep saved
work waiting.

If submission is **Unconfirmed** or **Failed**, use its **Retry** control to
reconcile that attempt instead of composing a duplicate. Check Chat for an
accepted message before resending. **Stop** cancels the selected active Run;
it does not reverse file edits or external actions.

**Pause** holds the selected work while preserving its history and reply route.
**Resume** waits for cleanup, then continues through a fresh recovery execution.
If a context handoff already committed, Resume keeps it and continues the original
task once; it does not rerun the handoff. Messages arriving during the hold remain
queued. A preparation error leaves the
work paused and shows its cause. Once the cause is repaired and cleanup finishes,
Resume retries a saved continuation packet exactly. An audit projection error
requires the restart shown by that error. Inspect uncertain external effects before
retrying. **Stop** cancels paused work as well.

### Answer a Decision or skip it

A **Decision** is a recorded question or approval request for you. Read the question
and scope, then choose an option or use **Something Else** / **Answer** when
shown. Approval applies only to the displayed action; answering in ordinary Chat
does not replace the Decision control.

**Skip question** closes that question without supplying an answer or approval.
It lets the Agent continue only with work that does not require that answer or
permission. A live provider request is declined when skipped. Skip does not stop
all work or grant access. If a live request has expired, follow its error and ask
the Agent to request it again if still needed.

The [school-library research example](learning/index.html#research-team-example)
shows how a team can compare quiet-study and group-work evidence, review claims,
and save a brief with sources. Supplied files, web research, delegation and a
standalone deliverable are optional. No code repository or implementation phase is required.

## Use the internal browser

The internal browser runs on the Engine host and appears in the Chat's Browser
panel. It is separate from your personal Chrome/Edge window.

1. Open **Browser** and choose **Open browser**.
2. Decide whether to enable **Remember sign-ins in this chat** before opening it.
3. Enter a **Website address** and use the page controls to browse yourself.
4. Choose **Agent** and select the intended agent to give it control. Use
   **Take control** to interact yourself.
5. Where Linux native controls are available, use **Browser controls & sign-in**
   or **Sign in privately (disconnect agent access)** for private sign-in.
   Finish in the manual surface and follow its **Done signing in** or connection control.

Closing the panel keeps the browser running. **End browser session** closes it
and can lose unsaved forms. **Reopen browser** replaces a failed session after
confirmation; tabs, forms and sign-ins are not guaranteed to return.

**Save browser across chats** explicitly shares a browser beyond its original
Chat. Operators can access its tabs/sign-ins; agents need permission. Saved-browser
Agent grants last until revoked. Use the displayed revoke action when access is no longer needed.

Chrome or Chromium must be installed on the host. If discovery fails, an operator
can set `PONDEROSA_BROWSER_EXECUTABLE` to its absolute executable path before
starting Engine. Linux native manual display uses Xvfb and x11vnc; native input
and link controls also use xdotool. Do not assume those native controls exist on
macOS or Windows. Final release notes must confirm browser versions and required host packages.

Connecting a personal local browser window and extension pairing are deferred
beyond beta. Retained extension source and older pairing instructions are not a
setup path for this release.

## Recover without losing your work

Start in Engine: read its status and **Work intake**, note **Version**,
**Revision** and **Data**, then inspect **Server** and **Errors** under **Live logs**.
Use **Refresh** and copy only the relevant redacted excerpt. Engine has no
provider-login form or Recheck button; **Recheck sign-in** appears in the web
app’s Provider Settings when applicable. Doctor is retired.

Preserve important unsent text and the relevant error before restarting.
Deleting Chats or clearing data/browser storage is not a routine recovery step.

| Problem | First action |
| --- | --- |
| Engine cannot start | Check **Server** and **Errors**, record the version/revision and data path. Do not delete locks or database files to force startup. |
| Web app will not open or authenticate | Check Engine is running and choose **Open Ponderosa** again. Keep its bootstrap address private. |
| Provider not found or access rejected | Read **Provider Settings** and **AI provider status** in the web app. Use **Recheck sign-in** where offered. Confirm the chosen CLI is installed and signed in for the Engine account; read account/limit details. **Test Access** makes a live request. |
| New Chat creation is unconfirmed | Use **Retry** on that attempt or **Recover earlier Chat** if offered. Keep browser storage available for recovery. |
| Send unconfirmed or a draft reappears | Check Chat for the accepted message, then use that submission's recovery controls. Review **Restore**, **Discard** and attachment notices before resending. |
| **Updates delayed** | Open its details and choose **Retry**, or allow reconnection. The notice does not mean an agent stopped. |
| **This view could not be loaded** | Choose **Try Again**, then **Reload Ponderosa** if offered. Preserve unsent input first. |
| Work active or queued | Read the Agent's status, work log and queue receipt. Use **Stop** only when you intend to cancel the selected work. |
| Internal browser failed | Read **Reopen browser** confirmation. Replacing the session can lose unsaved forms and tabs. |

Before **Restart** or **Quit Engine**, review active work and save important input.
Quit can offer **Stop Agents and Quit**. Interrupted tasks do not necessarily
continue automatically, and restarting does not undo external actions.

## Find and preserve your data

| OS | Default launcher data root |
| --- | --- |
| Linux | `$XDG_DATA_HOME/ponderosa`, or `~/.local/share/ponderosa` when unset |
| macOS | `~/Library/Application Support/Ponderosa` |
| Windows | `%LOCALAPPDATA%\Ponderosa`, with the user's `AppData\Local` fallback |

A configured override can change these locations. Engine's **Data** display
identifies the application data directory, normally the root's `data` child.
Logs are under `logs`, including `server.log` and `server-error.log`.

Earlier private builds used `Ponderosa Beta` (`ponderosa-beta` on Linux).
Changing the default does not move or delete that data. To reopen an existing
installation, set `PONDEROSA_LAUNCHER_DATA_DIR` to its original launcher root
before opening Engine, or use `--data-dir` with that root. Keep the original
root until you have verified your saved Chats. Existing Windows installations
may also retain their previous installer destination. Engine’s **Data** field
shows the root’s `data` child; pass its parent launcher root to the override.
For example, after choosing the correct bundle path from [launcher commands](#launcher-commands),
a Windows user reopening an original Beta root can use:

```powershell
$ponderosaOriginalRoot = Join-Path $env:LOCALAPPDATA "Ponderosa Beta"
& "$ponderosaBundle\ponderosa.cmd" open --data-dir "$ponderosaOriginalRoot"
```

Quit the existing Engine first and use the actual original root if it was
customized. This selects your saved data in place; it does not move or copy it.

Provider login material remains in the provider's own storage. Browser profiles
and remembered sign-ins are sensitive. Protect them and your backups.

**Deletion is permanent.** Agent deletion shows the affected Agent and delegated
Agents; it stops their active work before removing private history, Runs, work
logs, provider inputs and private attachments. Shared Chat messages, shared files,
coordination outcomes and working folders remain. Chat deletion removes the Chat
and its history plus the listed Agents and their in-app artifact views. Stop
active Agents first; pending work is cancelled. Files saved in the working folder
and Project-level artifacts remain. Read the confirmation rather than assuming
an in-app view will survive. Deletion is not archive or undo.

## Back up and restore

1. In Engine, note the **Data** location and the working folders used by your Chats.
   Back up the whole launcher root: the parent of the displayed `data` folder.
2. Finish or intentionally stop active work, then **Quit Engine**.
3. Copy the entire launcher root to a separate backup location. Also copy any Chat
   working folders outside that root. Keep those copies together and label them
   with the date and Ponderosa version.

To restore, quit Engine, keep the current folders as separate copies, and put the
backed-up launcher root and working folders back at their original locations.
Open Engine using that launcher root. Check a saved Chat, its attachments and
Files & Results, your settings, and the working-folder files before discarding
any previous copy. Restore complete folders; do not merge individual databases
or copy a live SQLite file alone. Agent/organization exports are not full backups.

These folder-copy steps passed with disposable data on macOS, Windows and Linux,
including saved messages, settings, attachment/result bytes, launcher configuration
and external files. Mac and Linux also checked Agent/Run identities and instructions.
The separate offline backup tool passed on Mac and Linux; its combined external-folder
restore failed on Windows. Use the folder-copy steps above there.
[Exact packages, methods and results](installation-checks.md) are recorded together.

Backups can contain private content and saved browser sign-ins. Protect them.
Provider subscription sign-ins remain in the provider's own storage.

## Update Ponderosa

1. [Back up your saved data](#back-up-and-restore), then quit Engine.
2. Download the next beta from the [release repository](https://github.com/khaleelclark/Ponderosa/releases).
   On macOS, replace the application with the copy from the new disk image. On
   Linux, install the new `.deb` over the existing package. On Windows, run the
   new installer. Keep your saved data and working folders in place.
3. Open Engine with the same launcher root as before. If updating from a private
   build that used `Ponderosa Beta` or `ponderosa-beta`, explicitly select that
   original root as described above; the new default does not move old data.
4. Check **Version**, **Revision** and **Data**, then open a saved Chat and check
   an attachment or result. Keep the backup until those checks pass.

Application replacement from the retained `1.0.0` build to `1.0.0-beta.1`
passed on macOS, Windows and Linux with the original disposable launcher root
explicitly selected. The [installation check results](installation-checks.md)
identify the exact revisions and the old-default-root discovery finding. This checks application replacement and data
continuity; no automatic migration between different storage formats was added.

Do not assume automatic download or installation of updates. Downgrades require
explicit release instructions.

## Uninstall Ponderosa

Finish or intentionally stop active work and quit Engine first. Keep your backup.

- **macOS:** move **Ponderosa Engine.app** to the Trash.
- **Linux `.deb`:** remove the application with `sudo dpkg --remove ponderosa-beta`.
- **Windows:** use **Settings → Apps → Installed apps → Ponderosa Engine → Uninstall**.
- **AppImage:** delete the downloaded AppImage file.

Application removal and data deletion are separate. Keep the launcher root and
external Chat working folders if you want to reopen your work after reinstalling.
Disposable macOS app removal, Windows uninstallers, Linux package removal and
AppImage-file removal preserved those files byte for byte. See the
[installation check results](installation-checks.md) for the exact checks and
the package-manager isolation used on Linux.

## Get help and report problems

Use this repository's [bug-report
template](../.github/ISSUE_TEMPLATE/bug_report.md) at [khaleelclark/Ponderosa](https://github.com/khaleelclark/Ponderosa/issues).
The repository is currently private. Include version/revision, OS, installation method, provider version,
reproduction steps, expected behavior and actual result. For internal browser
problems, include the host browser version and control mode.

Report suspected vulnerabilities privately using [SECURITY.md](../SECURITY.md).
Its reporting route must be enabled and verified at launch; it does not claim
reporting is already enabled or provide an approved fallback contact.

Engine's **Live logs** offers **Server**, **Errors**, **Refresh** and **Copy**.
Review copied text before sharing. Never post credentials, bootstrap addresses,
provider login directories, browser profiles, complete data folders or private
task/file content publicly. Beta feedback and documentation corrections are
welcome; external implementation/test-code contributions are not accepted.

## Launcher commands

Opening Engine is the normal entry point. For troubleshooting, launcher scripts
also live inside the application's bundled `Ponderosa` directory: `ponderosa` on
Linux/macOS and `ponderosa.cmd` on Windows.

For the default Linux `.deb` installation:

```sh
ponderosa_bundle=/opt/ponderosa-engine/resources/Ponderosa
"$ponderosa_bundle/ponderosa" status
"$ponderosa_bundle/ponderosa" version
"$ponderosa_bundle/ponderosa" diagnostics --output "$HOME/ponderosa-diagnostics.tgz"
```

For the standard macOS Applications destination, use those commands with:

```sh
ponderosa_bundle="/Applications/Ponderosa Engine.app/Contents/Resources/Ponderosa"
```

For the default Windows destination in PowerShell:

```powershell
$ponderosaBundle = Join-Path $env:LOCALAPPDATA "Programs\Ponderosa\resources\Ponderosa"
& "$ponderosaBundle\ponderosa.cmd" status
& "$ponderosaBundle\ponderosa.cmd" version
& "$ponderosaBundle\ponderosa.cmd" diagnostics --output "$env:USERPROFILE\ponderosa-diagnostics.tgz"
```

Adjust the path if installed elsewhere. AppImage paths are not covered by these
installed-directory examples. Choose an unused diagnostics filename outside the
data root. The archive excludes message bodies, artifacts, provider credentials,
browser sessions and raw logs, but includes paths and host information. Review
it before sharing. It is support metadata, not a backup or installation test.

The launcher also accepts `open`, `start`, `stop` and `restart`. `open` starts
the service if needed and opens the web app. `start` starts it without opening a
browser. `stop` and `restart` interrupt active work. Final packages must confirm
script permissions, paths and provider discovery for the actual download.

## Provider executable paths

Use this only if ordinary status, sign-in and restarting Engine did not resolve
**provider not found**. Engine discovers executables from its PATH and common
installation locations. macOS includes Homebrew and user-local paths; Windows
includes PATH, npm shims, standard provider folders and the standalone Codex path.
A WinGet package stored elsewhere must still be visible through PATH or an
explicit executable setting; a one-off qualification path is not required for everyone.

On Windows, these PowerShell commands locate an installed CLI without displaying
credentials:

```powershell
Get-Command codex -ErrorAction Stop | Select-Object -ExpandProperty Source
Get-Command claude -ErrorAction Stop | Select-Object -ExpandProperty Source
```

Quit Engine before applying a process-local override. For a default fresh Windows
installation, this example passes the discovered Claude path to that launch:

```powershell
$env:PONDEROSA_CLAUDE_BIN = (Get-Command claude -ErrorAction Stop).Source
& "$env:LOCALAPPDATA\Programs\Ponderosa\Ponderosa Engine.exe"
```

For Codex, the equivalent variable is `PONDEROSA_CODEX_BIN`. On macOS/Linux, set
the variable to the absolute executable path before launching Engine from that
terminal; macOS Finder does not inherit shell-only variables.

For a persistent setting, edit only the needed provider’s `executable` field in
`config/launcher.json` under the launcher root, preserving other settings. It
accepts `providers.codex.executable` and `providers.claude.executable`. Use an
absolute path and valid JSON; on Windows use forward slashes or escaped
backslashes. This file holds executable paths, not tokens or passwords. Restart
Engine after changing it and check the web provider status again.

### Sidebar accessibility and browser text size

Sidebar folders and their contents are nested lists. Resource links, star buttons
and context menus remain separately reachable by keyboard. Settings navigation
is a named navigation region. Active message placeholders use readable secondary
text in both themes. Browser zoom remains enabled; use your browser's zoom controls
for larger text and the normal theme controls for light/dark appearance.

Session rollover requests a short Agent handoff when either configured limit is
reached, then starts a fresh provider session at the next safe boundary. The
provider's own compaction remains the fallback. Provider Activity's input figures
include instructions, tool definitions, context and cached reuse; they are
reported tokens, not subscription quota, remaining context or cost estimates.

Your profile identity controls how Agents address you throughout Ponderosa.
Pictures are stored in managed workspace data. Use PNG, JPEG, WebP, GIF or AVIF
(up to 10 MiB); HEIC is unsupported because browser rendering is inconsistent.

For a local browser, use a dedicated Chrome/Edge window with extension 0.4.1.
Pairing can happen before sign-in. Existing and new application tabs in that
window are included; other windows stay outside access. Agent actions show a
temporary cursor. Sign-in pauses control while retaining the pairing; complete
sign-in directly, then use Resume browser access in the extension. Manual pause
is available anytime. Agents can attach PDF, DOCX and text files from their Chat
(up to 10 MiB).

Opening Rename from the Chat menu keeps keyboard focus in the name field, including
at larger browser zoom. Menu actions wait for the menu to close before opening the
next dialog or popover.

Detailed settings, package, browser and call behavior: [UI detail reference](ui-detail-reference.md). Save failure presentation and remaining text review: [UI text inventory](ui-text-inventory.md).
### Exported execution history

Full Agent and organization exports include execution history as a saved JSON log
file for each Agent with persisted execution events or Runs. The same applies to
Agent packages inside Branches workflows. After import, open the log in the
Agent's Files & Results. Re-export preserves its bytes. Template exports contain
no history.

The log records original source identities, normalized events, and Run status
and times. A source Run marked running remains a historical observation; import
does not start or resume it. Known credential fields are removed, but free-form
history can contain sensitive text, as the full-export warning states.

With local memory configured, full packages also transfer the selected Chat
team memory and included Agents' private memory, including versions and conflicts.
The destination needs compatible local models and memory storage. Templates
contain no memory. Fresh Branch workflow installations use the same path;
memory-bearing updates to existing workflows currently require separate migration
review and are refused explicitly.

Installation-global memory is explicitly excluded; a separate selected-global
transfer flow is still needed. Cross-Chat organizations require separate packages
and destination Chats. Provider-native sessions, exact provider inputs and
historical Branch execution Chats are not migrated. Full machine-to-machine recreation
remains incomplete. Execution logs share the existing 64 MiB managed-file and
aggregate package artifact limits; export fails explicitly rather than dropping
records when a limit is exceeded. Unsupported execution-archive versions and
malformed envelopes are refused before destination Agents are created.

### Branch webhook intake

Publish or install a webhook workflow with an empty source configuration (`{}`).
POST JSON to the webhook URL shown in the workflow, with a stable
`X-Ponderosa-Event-Id` header (1–200 characters). Intake uses ordinary Origin
checks and the 1 MiB request limit. It does not require an operator token,
signing secret, HMAC signature, or timestamp freshness header. Provider sign-in
is separate and unchanged.

Keep the same event ID when retrying the same event. Equivalent canonical JSON
returns the original occurrence; different input under the same ID returns a
conflict. Give a new event a new ID. Event data remains untrusted and cannot
select an Agent or claim manual execution authority. Pause intake with the
workflow's intake control.

`replayWindowSeconds` is retired network admission configuration, including
nondefault values. Existing intake no longer applies it. For a new publication
or package installation, remove that field and use `{}`. If a workflow needs a
business rule about event age, express it as a workflow condition using event
payload data. Existing occurrence records and their historical provenance are
retained. Historical database credential columns and old local key files are
inert; this change neither reads nor deletes those files.
