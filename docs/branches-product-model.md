# Branches product model

Branches and Dev share Ponderosa Engine. A Chat is the ownership boundary: a Dev Chat has no Branch owner; a Branch Chat has one Branch owner. Agents inherit that ownership. Branches may contain no Chats. Persistent Chats live under the Branch, and temporary Chats live under the execution that created them.

The Branches shell uses the existing conversation, Agent, organization, import, files, and work surfaces through a product-scoped Engine transport. Scope enforcement applies to direct resource access, collection pagination, search, notifications, recent resources, preferences, and event streams. This is a product boundary for the same local operator, not a multi-tenant security boundary or filesystem sandbox.

## Executions

Every admitted execution freezes its workflow, binding revision, normal parameters, script source, and limits. Persistent organizations retain living history; their provider context is not frozen. A Branch Call passes only explicit text and admits the child's current active definition and configuration. Calls record an exact parent execution and parent attempt. Canceling a parent fences its descendant execution tree, without affecting unrelated child executions.

Disabling a trigger stops that trigger. Disabling a Branch makes incoming calls wait durably. Waiting parents, human gates, retry delays, and disabled dependencies do not occupy runnable capacity. Provider work still uses the existing Engine scheduler and its per-Agent constraints.

Nested depth, graph traversal, and loop traversal ceilings remain effective through the execution tree. Each loop edge also records local iteration identity. Loop traversals consume the Branch's aggregate loop budget, including work in nested calls. Failure handling has a separate bounded traversal allowance, using the same configured traversal ceiling, so exhaustion can route to a gate or recovery Step without creating an unbounded recovery loop. Limit exhaustion is explicit runtime evidence. A canceled child has a distinct runtime outcome and can follow a canceled edge, retry policy, human gate, or termination policy.

An ordinary retry retains the temporary Chat for the same logical Step invocation. A fresh retry fences and drains the prior organization, retains its inspectable execution history, and creates a new Chat generation. A loop creates a new logical invocation. Parallel inputs and join ordering follow graph configuration rather than completion timing.

## Parameters and credentials

Normal values belong to the installed Branch, not to a Step result. Agent instructions, graph text, working directories, and trigger configuration use `{{parameter:name}}`; Scripts receive normal configuration through `PONDEROSA_PARAMETERS`. Paths remain paths and never cause implicit file-content injection. The universal result remains `{ failed, output? }`.

Secret declarations cannot have defaults or exported values. Opaque local bindings are Engine-owned; ordinary settings reads expose configured status only. They cannot be changed through the generic settings API, interpolated into prompts, or consumed by arbitrary Scripts. No general credential store or new secret-consuming Action is introduced. Future explicit Engine consumers must resolve the live binding at operation time and control output exposure.

## Packages and lifecycle

An installation package has a stable package identity and exact logical Chat and Agent identities. Imports always create a new local Branch and new Engine resource IDs. Updates explicitly target one installation. Preview makes preservation, creation, settings, organization changes, and removal visible before confirmation, including concrete before/after configuration. Confirmation rejects stale Chat or Agent settings. Preserved Agents keep history and opening instructions; allowed runtime/settings changes apply to future work. Incoming history does not overwrite preserved history.

Publication, resource reconciliation, and the completion receipt commit together. Tracked Agent import receipts make interrupted provisioning retryable. Conflicting external edits are blocked while an update is applying. Removed resources disappear from the active installation and remain in a retiring state until executions that referenced them drain. Failure to drain remains visible and retryable. Agent-only removals retain the set of pre-update executions, so new executions in the retained Chat cannot postpone deletion indefinitely.

Branch deletion fences intake, rejects callers/dependencies, cancels and drains active work, and invokes existing Chat/Agent lifecycle machinery. Source directories are never deleted. No merge or production replacement is implied by verification of a feature branch.
