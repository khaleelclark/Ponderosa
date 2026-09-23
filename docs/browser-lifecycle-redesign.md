# Browser lifecycle redesign — experimental

## First rollout

The chat browser has one opening path: an ordinary headed Chrome process with
native manual interaction. It can later attach automation with Chrome's explicit
approval, without creating a replacement browser. Existing legacy/local sessions
are not silently converted or replaced.

An explicit Remember sign-ins choice selects a chat-owned trusted Chrome profile.
The profile ID, not its display name, is its identity. Temporary browsing does not
delete the saved profile. A small additive SQLite mapping retains that identity
across temporary mode and profile renaming. Chrome owns its credential storage;
Ponderosa does not read or copy cookies/passwords.

Use myself returns control without disconnecting Chrome. Sign in privately is
the separate explicit disconnect action for native sessions. Let agent work connects
the same session and grants the selected Agent's current or next Run. The server
resolves that choice, avoiding a client health-check race. Run completion revokes
access. Connection failure does not launch a fallback browser. Closing the panel
only hides it; ending the session remains a separately confirmed operation.

Chrome approval remains a real user action. This change does not bypass website
verification, guarantee Google acceptance, or establish OAuth compatibility.

## Saved browser and independent lifetime

### Saved-browser promotion experiment

An operator can explicitly promote one hosted, remembered-sign-in browser to the
reserved saved-browser ownership namespace. The confirmation discloses that all
authorized instance operators can access its tabs and signed-in accounts; this
is not per-user privacy. Promotion serializes with browser actions, requires the
exact session and operator control epoch, and rejects active/pending agent access,
connection-in-progress, temporary profiles, and replacement of an existing saved
browser. It neither copies a profile nor restarts Chrome.

The profile catalog transfers ownership transactionally before the in-memory
session is rekeyed in the same synchronous continuation. Browser ID, process,
tabs, and profile ID remain unchanged. Old chat-scoped actions and viewer tickets
are fenced. Driver events use the current owner after promotion. Source-chat
deletion no longer matches the session or profile owner.

The header switcher changes only the viewed browser. Saved-browser grants name
an explicit source chat and Agent. The server validates that relationship,
resolves current/next Run, rejects conflicting controllers and multiple browser
grants for the same Agent, and revokes access on Run completion. Artifact access
is resolved through the exact borrowing Agent's chat and existing read checks,
not through the chat from which the browser was originally promoted.

Saved profile metadata persists across restart. Only
one saved browser is supported; replacement/unsaving and conversion of a live
temporary profile are not implemented. These must not be simulated by closing,
copying credentials, or silently replacing either browser.

With `PONDEROSA_BROWSER_SERVICE_SOCKET` configured, shared native browsers are
owned by the independent `ponderosa-browser-experimental.service`. App shutdown
detaches instead of closing them; app startup adopts the same session and resets
control to the operator. Private per-Run browsers remain ephemeral. Without this
service configured, the original app-owned lifetime applies and the UI says so.

The service uses a mode-0600 Unix socket inside a mode-0700 directory. A new app
incarnation fences old callers and waits for in-flight operations. Identity-only
checkpoints retain ownership, never cookies, passwords, URLs, or Run grants.
Saved-profile ownership remains authoritative in SQLite. A missing supervisor
session becomes an explicit failed browser, not a replacement or restored draft.

The browser service itself must not be restarted during ordinary app deployment.
Restarting the service or host closes live tabs: Chrome profiles preserve sign-ins,
not arbitrary unsaved forms. An initial installation still requires closing any
old app-owned browser explicitly. Never claim the service makes Google sign-in or
CAPTCHA acceptance universal.

Lifecycle qualification covers:

- The service exclusively owns Chrome, display, VNC, and trusted-profile leases.
- App connection loss revokes automation and input permissions, but preserves
  the browser. No stale Run/epoch authority survives reconnection.
- Authenticated local IPC uses server-owned session identities; clients cannot
  supply arbitrary sockets, profile paths, or debugging endpoints.
- An app restart reconnects to the same browser process, profile and tabs.
- Chat deletion, explicit End Browser, and host shutdown confirm process exit
  and retain failed teardown for retry. They do not orphan persistent browsers.
- A broker crash is distinct from a viewer disconnect; it never silently starts
  a replacement or reports restored unsaved forms.
- Deployment drain distinguishes safely retained browsers from active provider
  work, without weakening deletion or shutdown fences.

Qualification must include typed unsaved form data across app restart, Run
completion and reconnect, mobile keyboard continuity, stale grants, concurrent
viewers, profile exclusivity, failed cleanup and rollback. A persistent cookie
test alone is insufficient.

The focused broker checks cover full Fastify shutdown/startup, stale leases,
profile exclusivity, opening/claim races, abandoned deployment drains, and missing
service sessions. The opt-in real Chrome manual-browser check preserves editable
unsaved text across manager reattachment and opens a second link without replacing
the draft. Playwright checks cover 30 tabs, rejected field input, shadow controls,
and frame-scoped interaction. These fixtures do not qualify every employer site.

## Interaction

### Page-first workspace presentation

New native hosted browsers use one continuous window display before, during,
and after automation connects. Chrome supplies the real tabs, address bar, and
native dialogs; Ponderosa supplies the workspace/window and control handoff.
Displaying and resizing this window does not attach debugging. The hosted window
is resized to the panel at 2x pixel density, bounded to 1280x1280 logical pixels;
the capture follows its geometry instead of letterboxing the whole desktop.
The screen-region capture includes overlapping native menus/dialogs inside the
window bounds. This is not a new embedded browser engine or DOM renderer.

An independent server-side view-only VNC socket is selected while an Agent owns
control; client-side viewOnly is additional UI protection, not the authority.
Session/epoch fences revoke old input sockets on handoff. Only the operator can
resize the native window, serialized against control changes. Private sign-in
remains checkpointed, and no automatic debugging connection is attempted merely
to display a native-capable browser. Chrome approval is still required for agent
automation when Chrome requests it. Local/legacy browsers retain their existing
page-view transport; capability negotiation avoids invoking the new methods on
an older browser supervisor. Activating the new native capability requires a
browser-service restart and explicit authorization to close live browsers.

The app can retain four panel views of distinct chat/Run browsers. One panel owns
the dock; others float independently. Mobile shows the foreground panel and uses
the workspace menu to switch, preserving each panel's selected chat/saved-browser
identity. Closing a panel never ends its browser. A fifth panel is refused with
an explanation, not substituted for an existing view. These are UI views, not a
new ownership domain or permission grant. Window layout itself is not persisted
across a full app reload. Opening a chat link respects that panel's selected
browser identity. The UI and backend both permit 30 tabs per browser.

Agent tools expose explicit new tabs, current-page-bound coordinate clicks and
scrolls. Inspection supplies bounded frame-scoped controls; fill verifies the
immediate resulting value. Later validation and server-side upload acceptance
still require site-specific inspection. The cap is 30 tracked tabs; overflow is
not destructively closed. Shared/profile capacity is eight by default.

Ordinary chat links open a new Ponderosa tab; modifier-click remains external.
The address field accepts searches and rejects executable/internal schemes.
Chrome's own connection setup remains a user-approved action, with a button to
open its setup page. It is not repeated for each Agent Run while that browser
survives. Saved-browser operator artifact uploads still require an explicit Agent
grant to identify the source chat; profile sharing is instance-wide, not private.

Dev and production are out of scope until explicitly authorized.
