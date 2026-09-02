# Ponderosa

Ponderosa is a self-hosted workspace for durable work with AI Agents. It runs
Codex and Claude through the operator's existing subscription-authenticated
provider CLIs; Ponderosa does not accept provider API keys.

An Agent is a stable identity with settings, history, files, and a place in an
organization. A Run is one temporary, scheduler-owned turn for that Agent. The
local Ponderosa Engine persists the causes and results of work around those
temporary provider sessions, so a browser tab or provider process is not the
system of record.

## Start here

- [How Ponderosa works](docs/system-model.md)
- [Private beta installation](docs/private-beta-installation.md)
- [Deployment](deploy/README.md)
- [Interactive Agent browser](docs/interactive-agent-browser.md)

The web application is the primary client and can be installed as a PWA. The
desktop Engine application and `ponderosa` command manage the local service;
they are not separate stores or alternate Agent runtimes.

## Credits

Ponderosa was created by [Khaleel Clark](https://github.com/khaleelclark).
