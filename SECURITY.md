# Security Policy

## Threat model

Ponderosa is a single-operator application for a trusted home host. Its HTTP API
can create projects, read files inside registered project roots, and start coding
agents that intentionally run as the service user with full host access. Anyone
who can operate the API can therefore act with that user's authority. Ponderosa
protects the browser/API boundary; it is not a sandbox for agent runtimes or
untrusted repository content.

The primary threats are unauthorized network clients, malicious web pages making
cross-origin mutations, path or symlink escapes from the file browser, leaked
short-lived runtime capabilities, resource exhaustion, and accidental disclosure
through logs or cached responses. Subscription credentials remain owned by the
engine CLIs and must never be placed in Ponderosa configuration, logs, or git.

## Supported deployment assumptions

- Run one Ponderosa instance for one trusted operator on a host the operator
  administers. Multi-user or mutually untrusted use is unsupported.
- Put the service behind a private network gate such as Tailscale, or an HTTPS
  reverse proxy with real authentication. Ponderosa is network-agnostic and does
  not treat forwarded headers as proof of identity or transport security.
- Set a long, random `PONDEROSA_AUTH_TOKEN` whenever the listener is reachable by
  anything other than a tightly controlled private network. Deliver it only in
  the `Authorization: Bearer` header and keep it out of URLs and browser storage.
- Keep `PONDEROSA_AGENT_BASE_URL` host-local. Runtime callback capabilities are
  bearer credentials scoped to one active run and are revoked when it ends.
- Run the service as a dedicated, unprivileged OS user when practical. Protect
  the data directory and CLI login directories with OS permissions, use HTTPS at
  the network edge, and keep dependencies patched.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository owner using
GitHub's private vulnerability reporting feature. Do not open a public issue with
secrets, exploit details, host paths, access tokens, delegation prompts, or event
logs. Include the affected revision, deployment topology, reproduction steps, and
impact. Revoke any exposed operator or runtime token and preserve relevant logs
after removing secrets.

## Remaining risks

- Agent runtimes deliberately inherit the service user's filesystem, shell,
  network, and subscription login access. Prompt injection or a compromised engine
  can act with that authority; this is an accepted v1 design decision.
- The optional application bearer token is a single shared operator secret, not
  user identity, OAuth, authorization roles, or a credential store.
- Denial-of-service controls are proportional local limits, not a distributed
  rate limiter. A client already authorized to launch agents can still consume
  substantial CPU, memory, disk, network, and subscription quota.
- Project owners choose registered host paths. The file browser prevents traversal
  and symlink escapes from those roots, but intentionally exposes files within a
  registered root to the operator.
- Canonical event logs retain commands, file changes, conversation, and agent
  errors for audit and recovery. Treat the data directory and backups as sensitive.
- Security at the TLS/reverse-proxy/private-network edge remains the operator's
  responsibility. Public deployments require a real identity gate.
