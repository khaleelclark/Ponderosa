# Ponderosa

[Website](https://ponderosa.khaleelclark.com/) · [User guide](https://ponderosa.khaleelclark.com/ponderosa-guide/) · [Download](https://github.com/khaleelclark/Ponderosa/releases/latest)

Ponderosa is a self-hosted workspace for continuing work with AI agents. Use
one agent or organize a team to research a question, coordinate a project,
develop a creative brief, or build and review software. Conversations, agent
roles, assignments and saved results stay available when you return.

You work in a web app. **Ponderosa Engine** runs the service on your computer
and manages startup, status and logs. AI work runs through subscription-authenticated
provider tools on that computer; Ponderosa does not accept provider API keys.
Saved history helps work continue, but does not mean an agent recalls every detail.

## Public beta

`v1.0.0-beta.1` is the first public beta. The release repository is [khaleelclark/Ponderosa](https://github.com/khaleelclark/Ponderosa), [public releases](https://github.com/khaleelclark/Ponderosa/releases)

Linux, macOS and Windows are the beta targets.

Codex and Claude Code are both included, using your existing provider
subscriptions. Choose either provider, or configure both. Available models,
reasoning settings and tools depend on the provider and account.

## Prerequisites

- A computer you administer and a modern web browser.
- Codex CLI or Claude Code installed and signed in with your subscription under
  the same OS account that runs Engine. See [provider setup](https://ponderosa.khaleelclark.com/ponderosa-guide/#first-run).
- For internal browsing, Chrome or Chromium installed on the Engine host.
  [Browser setup](https://ponderosa.khaleelclark.com/ponderosa-guide/#browsers) explains the platform limits.

The application packages include their own Node runtime. Node and pnpm are
needed only to develop or build Ponderosa from source. Agents use the host
account’s files and shell; a working folder is not a security sandbox. Self-hosting
stores Ponderosa’s records locally, while AI requests still go to your provider.

## Install and open

The [installation and user guide](https://ponderosa.khaleelclark.com/ponderosa-guide/#first-run)
describes the planned packages:

| Beta target | Package format |
| --- | --- |
| Ubuntu 24.04 x64 | `.deb` |
| macOS 14+ on Apple Silicon | `.dmg` |
| Windows 11 x64 | Installer `.exe` |

**Windows:** Smart App Control may block this unsigned beta from starting.

The release notes will identify the exact offered packages and their checks.
An AppImage recipe exists, but no AppImage is currently selected. The platform
targets do not establish minimum-OS qualification or support for other platforms.

Once the release is published, use its package and instructions for your platform.
Open **Ponderosa Engine**, then **Open Ponderosa** to enter the web app. Closing a
web tab leaves the service running. **Quit Engine** stops it and can interrupt work.
See the [user guide](https://ponderosa.khaleelclark.com/ponderosa-guide/) for sign-in, recovery, local data and updates.

## Try a first task

A **Chat** holds a conversation, agents, instructions and a working folder.
An **Agent** is a continuing worker identity. A **Run** is one turn of that agent’s work.
You can start with an ordinary Chat before creating a team.

1. Choose **New Chat**, then select Codex or Claude Code and an available model
   in the composer. Choose **Reasoning** where offered, or keep the default.
2. Send: “Write a three-item checklist for planning a picnic. Reply in this
   Chat. Do not browse or change files.”
3. Read the reply, then ask: “Make the checklist suitable for rainy weather.”
4. Reopen the web app through Engine and return to the saved Chat.

For a larger noncoding task, ask how a school library could support both quiet
study and group work. Supply reports or links, compare evidence and trade-offs,
and ask for a brief with sources. An ordinary folder is enough; Git and file
uploads are optional. The [research-team walkthrough](https://ponderosa.khaleelclark.com/ponderosa-guide/#research-team-example)
shows how agents can divide, review and combine that work without a coding phase.

## Learn more

- [Installation and user guide](https://ponderosa.khaleelclark.com/ponderosa-guide/#first-run): setup, everyday use,
  troubleshooting, data and updates.
- [Interactive user guide](https://ponderosa.khaleelclark.com/ponderosa-guide/): how Chats, agents, assignments,
  decisions, files and the internal browser work, with search and navigation.
- [Source development](https://ponderosa.khaleelclark.com/ponderosa-guide/#setup): Node 24, pnpm 11.10.0 and
  a separate development data directory. Source builds are separate from installation.
- [Packaging and platform qualification](packaging/README.md): maintainer build
  and release commands.
- [Linux service deployment](deploy/README.md): advanced host and network setup.

## Help and feedback

Use this repository’s bug-report template once public reporting is available.
[Bug-report guidance](.github/ISSUE_TEMPLATE/bug_report.md) lists the useful details.
Remove credentials, personal information and private task content from logs and
screenshots. Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

For startup or access problems, begin with Engine’s status, **Work intake**,
**Data**, and **Server**/**Errors** logs. If the web app opens, check **Provider
Settings** and use **Recheck sign-in** where offered. See the
[recovery guide](https://ponderosa.khaleelclark.com/ponderosa-guide/#recovery) before changing files or paths.

Beta feedback and documentation corrections are welcome. External implementation
and test-code contributions are not being accepted during this beta. No response
or fix deadline is promised.

## Credits

Ponderosa was created by [Khaleel Clark](https://github.com/khaleelclark).
