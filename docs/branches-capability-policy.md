# Ponderosa capability policy

## Decision

Capability policy is Engine authority shared by every Ponderosa product. Branches is the first product UI for it. A policy removes capabilities that are otherwise available; it never creates provider, connector, filesystem, or workflow authority.

The initial rule is deliberately small:

```text
effective restrictions =
  global
  ∪ product
  ∪ Branch
  ∪ Chat
  ∪ Agent
  ∪ Run
```

A descendant may add restrictions. It cannot silently restore a capability removed by an ancestor. Future approval or explicit exception records can be added as distinct policy objects without changing the meaning of today's restriction records.

## Canonical storage and scopes

SQLite stores capability policies because they are runtime authority, not presentation state. Each record is keyed by a scope kind and stable scope ID, has an optimistic revision, and contains a sorted set of restricted capability IDs.

The supported scope kinds are:

- `global`, with the singleton ID `ponderosa`;
- `product`, initially `interactive` or `branches`;
- `branch`, keyed by Branch ID;
- `chat`, keyed by Chat ID;
- `agent`, keyed by Agent ID;
- `run`, keyed by scheduler Run ID.

Branches owns Chats, and Chats own Agents. The resolver derives the product and Branch layers from Chat ownership rather than adding a second Agent ownership model. A Branch-owned Agent therefore resolves through global, Branches product, its Branch, its Chat, its Agent, and its Run when present. An interactive Agent resolves through global, interactive product, Chat, Agent, and Run.

The first UI edits Branch, Chat, and Agent restrictions inside Branches. Global, product, and Run scopes are part of the same Engine model but do not get premature settings screens.

## Capability catalog

The catalog gives stable user-facing IDs to actual enforcement seams. Categories are navigation and bulk-control conveniences; individual capabilities remain addressable.

The first catalog includes:

- browser reading and browser interaction;
- managed Agent creation;
- importing host files into managed storage;
- filesystem writes for provider sessions where the adapter can enforce it;
- Branch Calls, Script Steps, and Notify Steps;
- configured provider connectors, addressed individually as `connector:<engine>:<name>`.

Ponderosa's communication, Request, Join, steering, and lifecycle tools are protocol machinery. They remain required for a managed Agent to behave coherently and are not presented as optional capabilities.

Shell/process denial and filesystem-read denial are intentionally absent from the first editable catalog. Current provider contracts do not enforce those boundaries consistently enough to make the controls truthful. They can be added when each adapter can prove the restriction at execution time. Branch Script Steps are separate Engine operations and are enforceable now.

## Enforcement

Policy is resolved when a Run is prepared. Ponderosa dynamic tools are filtered before the provider session is opened, and the effective restriction set participates in the provider-session contract hash. A policy change therefore cannot leave an old persistent session with stale tools; the next Run gets a new compatible session generation.

Provider adapters receive a normalized runtime restriction object. Codex uses its per-thread sandbox and app configuration for restrictions it can enforce. Claude uses its provider-owned disallowed-tool controls. An adapter must fail closed for a requested restriction it claims to support; it must not silently pretend a restriction exists.

Managed child Agents do not copy privileges. They resolve through their Branch and Chat plus the immutable managed-spawner lineage and may add their own restrictions, so Agent creation cannot restore authority removed from the Agent that spawned them.

Branch operations are checked by the Branch execution authority before the operation is admitted. A restricted Branch Call, Script Step, or Notify Step becomes an explicit failed Step outcome eligible for the workflow's normal failure routing. It does not stall silently.

## Connectors and discovery

Connector entries are derived from Engine capability discovery. A connector is available only when the provider reports it configured and usable. Restricting a connector removes it from the provider session configuration. The UI distinguishes unavailable Engine capability from a policy restriction and identifies the first restricting scope.

Policies are local installation authority. Exported Branch packages do not grant capability or erase local restrictions. A future package format may declare recommended restrictions, but applying those recommendations must remain an explicit local decision.

## UI contract

The primary view answers what the selected Branch, Chat, or Agent can do. It groups controls by category and shows `Available`, `Restricted here`, `Restricted by Branch`, `Restricted by Chat`, or `Unavailable` beside each item. Provenance is secondary detail.

Branches keeps its own product information architecture. It reuses Ponderosa typography, spacing, cards, semantic status, form behavior, notification language, Chat/Agent surfaces, and provider telemetry. Platform settings such as provider sign-in remain in Ponderosa settings and are linked rather than copied.

Branch settings use focused internal navigation for General, Execution, Capabilities, Provider Activity, Dependencies, and Delete workflow. Provider Activity is the same truthful telemetry component used by interactive Ponderosa, scoped to the selected Branch. It does not claim subscription quota or monetary cost.

## Deliberate boundaries

- No allow-first or IAM-style precedence model.
- No ordinary descendant override of ancestor restrictions.
- No new unattended approval system.
- No capability control that cannot be enforced consistently.
- No duplicate Branches Agent runtime, scheduler, provider settings, notification transport, or usage ledger.
- No coupling of capability policy to package identity, Branch parameters, or prompt interpolation.

These boundaries keep the first release understandable while leaving room for explicit human-gated use and reviewed exception objects later.
