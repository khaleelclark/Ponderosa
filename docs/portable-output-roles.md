# Portable output and speaker roles

Agent/organization packages may contain `outputRoles: [{ref, output, speaker}]`.
Branch installation packages use `{chatRef, agentRef, output, speaker}` instead.
Refs must name included persistent Agents, be unique within their package/Chat,
and declare exact booleans. At most one declaration is a speaker, and it must be
an output. Local IDs as authority, app URLs, initialized/setup state, permissions
and credentials are never portable role fields. Template/full exports filter
roles to included live persistent Branch owners. Copy JSON is an export;
Duplicate Agent/organization deliberately omits role intent.

Imports are explicit human operations. The server validates all role declarations
and returns a review bound to canonical package contents, destination and current
role state. Client worker previews are advisory. Generic organization imports
into Core Chats show roles as inactive; only active persistent Branch owners can
activate output roles. Branch exports normalize all roles at the enclosing
package level. Matching nested declarations normalize to the same result;
contradictory nested/enclosing declarations and foreign refs are rejected.

When a live speaker exists, both import dialogs show:
“You already have a Ponderosa speaker. The imported speaker will be disabled.”
The existing speaker, workflow, model and history stay intact. Eligible imported
outputs are still enabled. Only the imported speaker designation is inactive;
the imported Agent and its workflow are not automatically disabled. With no
speaker, a reviewed eligible declaration can activate it. A pending default
Assistant setup makes imported speaker intent inactive. A collision or state
change after an activation review requires a fresh review. A previously reviewed
inactive outcome stays inactive during its recovery even if the old speaker is
removed. Normal speaker editing, moving, disabling and recreation use the same
OutputAgentApps role owner and do not grant any new access.

Updates affect only explicitly declared mapped targets: omitted role declarations
retain local human choices. `output:false,speaker:false` explicitly removes that
target's output role; `output:true,speaker:false` retains an output but removes
its speaker role. The preview includes each declared before/after role delta.
Unrelated outputs are never blanket replaced. Resources removed from a package
follow existing retirement/drain rules and cease to be eligible output owners.

## Durable publication and recovery

SQLite creation/installation receipts and the workspace preferences journal are
different stores. Role writes never run inside the SQLite publication callback.
The SQLite commit first records exact mapped Agent identities and the reviewed
outcome. Only committed active owners can receive roles. A single subsequent
workspace journal append changes roles and records an applied marker together.
The final SQLite receipt is then acknowledged; its durable done flag permits
removing the transient journal marker. Restart/retry checks the applied marker
before effects, so a later human removal/move is never undone by replay.
Report cursors are pinned once before the journal boundary and never reset.

Monotonic global role state and per-Agent designation epochs fence human changes
during staging and recovery. A changed activation review never replaces a newer
speaker. Even an inactive speaker import cannot resurrect an output that the
human subsequently removed. Re-review uses the existing mapped outcome; it never
creates another copy of the imported Agents. Once Branch resources are published,
Stop cannot pretend to roll back that durable import: finish role recovery first.
Before publication, failure/cancellation uses existing staged-resource cleanup.
An empty compensation journal is cleared durably so cancellation can finish.

No new SQLite schema or migration is needed. Review/apply markers use the existing
canonical preferences journal; mapped outcomes use existing creation receipts or
installation plans. At most64 pending reviews are retained to bound preferences
and outstanding UI work; unclaimed reviews expire after24hours, and terminal
failed/canceled reviews are pruned before accepting another. Completed applied
markers are pruned only after the corresponding durable completion is known.
Notification failure cannot roll back a committed import.

Generic JSON, binary, background and programmatic import paths share validation
and finalization. Programmatic role-bearing generic imports require a human review;
Branch staging hooks defer all normalized roles to the enclosing Branch import.
Background role failures retain their payload and pending finalization identity,
show the exact error, and offer re-review/confirmation in the import form. Startup
attempts pending finalizations without recreating Agents. Operational notices
identify unresolved role recovery. The advanced recovery endpoint is
`POST /api/projects/:id/agent-role-finalizations/:creationOperationId`: an empty
body obtains a server review (or finishes an already safe retry); `{reviewId}`
confirms it. Use the owning Branch product namespace when appropriate. Branch
installation recovery uses `POST /api/branches/installations/:id/role-review`
and the existing confirm endpoint with `outputRoleReviewId`. Both endpoints
validate current destination ownership and derive target IDs from durable receipts.

## Controlled verification

`tests/branches/output-role-import.test.mjs` covers strict/ref validation,
template/full and role-free import/export, Core inactivity, same-target updates,
collisions, state changes, record-staging fences, publication/journal/receipt
faults, restart/replay, later human removals, cancellation and default-setup races.
The held default-setup case is a service-boundary test, not a provider experiment.

After building, run the real two-entry-point browser check:

```
TMPDIR=/tmp node --import ./tests/shared/workspace-resolution.mjs tests/branches/output-role-import-ui.mjs
```

It uses installed Chromium, owned loopback servers and inert adapters. It uploads
an actual exported organization through the Chat import dialog and an actual
exported Branch through Import workflow, observes both collision warnings,
confirms the imports, checks all mapped outputs/the existing singleton, then
reopens the canonical store and checks the same outcomes. It installs nothing
and uses no provider account, microphone or inference. This finite feature check
is not a generic portability matrix, whole Assistant, #25, #31 or Bible acceptance.
