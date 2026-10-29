# Reliability qualification and remaining portability work

## Notification regression

Ordinary Agent responses and broadcasts default to quiet unread activity. Quiet metadata is durable in the workspace event log, keyed by canonical Communication identity, and separate from notifications and push delivery. The existing projection returns `quietUnreadCount` for requested Chats and folders; this count makes Chat titles bold and does not enter alert badges or notification totals. Read-visible acknowledges the exact Communication IDs with the existing product-ownership check. Preferences explicitly saved by the user remain authoritative.

The regression fixtures use controlled inert providers and disposable canonical stores. Core and Branches each emit 30 replies across three Agents. Checks cover zero default alerts, exact quiet unread counts, restart persistence, read-visible clearing, and Branches/Core isolation. Core additionally checks opt-in direct response alerts and saved settings after restart. No real provider account is used.

## Portability remains incomplete

The full Agent v1 package schema still contains setup, conversation history, and artifacts, but no local-memory chunks or execution records. The Branch installation format delegates Agent snapshots to the same exporter and inherits those omissions. The full-export dialog warns that history and stored data may contain sensitive information; known credential fields remain outside the schema. This warning does not establish full portability.

Complete the omission fix through one shared migration path:

1. Add a versioned portable memory snapshot with exact text, metadata, embeddings, supersession/conflict history, visibility and source provenance. Include Chat memory once per Chat and explicitly define global-memory inclusion. Rebind installation/Chat/Agent authority through the host service; never copy the source installation principal or credentials.
2. Preserve execution evidence as imported historical records with source identity, exact output, timestamps and terminal outcomes. Do not insert runnable source scheduler leases, capability tokens, fences or activations into the destination scheduler. Surface the imported records in existing history/Runs reads and re-export them.
3. Extend the shared strict parser and size accounting before mutation. Extend the durable import operation to stage, commit, recover and roll back memory and execution archives together with Agents/artifacts. Cover retry, cancellation, destination deletion and crash windows. Branch imports and updates must use the same path and retain stable external references.
4. On separate fresh disposable Core and Branches stores, seed public/private Chat memory, execution output, a completed Run and a representative workflow; round trip and reopen. Compare every field after explicitly documented destination identity remapping. Assert known secrets absent and the export warning visible. Repeat the import to verify idempotency without duplicate memory or history.

## Upgrade and repetition plan

First integrate reviewed fixes into one pinned candidate. Build all workspaces, run the full repository test runner once, retain failures/skips, and fix failures before any streak attempt. Do not count isolated lane checks as a full core-path pass.

Upgrade separate populated disposable Core and Branches stores from the previously audited ui096 build to the integrated candidate using the actual startup/migration path. Preserve old and upgraded copies. Compare Agent identity/settings, organization edges, Chat messages/instructions, artifacts, memory chunks/ownership, historical execution output, Branch definitions/bindings/triggers and pending coordination outcomes. Use no real credentials or paid provider calls. Then run controlled messaging, handoff and restart flows on the upgraded stores.

Only after integrated fixes and upgrade qualification pass, run the complete controlled core-path suite 20 consecutive times with a fixed source commit, command, environment and manifest. Retain every run's output and skips. Any failure breaks the streak; identify and fix it, then restart. Provider-backed or external checks skipped by the suite remain unverified and cannot be presented as passing.

First-run timing starts with the installer downloaded and a provider already signed in. Use a fresh disposable user environment and the published docs; record each step through the first reply. Missing authorization must be supplied by the operator and cannot be bypassed. Phone/provider-only checks go on the operator handoff checklist without blocking independent source fixes.
