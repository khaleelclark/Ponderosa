# Ponderosa Branches

Open `/branches` on your Ponderosa server. Branches provides a separate workflow editor and execution view; **Open Dev** returns to the Project/Agent workspace.

## Build and deploy

1. Create a Branch. Add persistent Chats under **Chats** only when the workflow needs Agents. Script-only workflows need no Chat. Choose each Script’s working directory explicitly.
2. Select a Step to edit it. Add Scripts, Branch-owned Agents or organizations, temporary Agent templates, human approvals, Branch Calls, notification Actions, conditions, and parallel paths.
3. Configure failure handling and execution limits. Parallel paths have a paired join: all, any, or a quorum, with explicit result order and a choice to finish or cancel remaining work.
4. Review deployment. Bindings identify Branch-owned Agents, working directories, called Branches, installed subscription engines, and local trigger settings. Deploy creates an immutable definition and binding revision.
5. Open Executions and run the deployed version. Draft edits do not change already accepted work.

Scripts run in Node.js, read their explicit input from stdin, and write their result to stdout. stderr is retained as execution evidence. Large results should be explicitly referenced managed artifacts; inline text is bounded. Conditions compare their explicit input with a configured string. A Script can calculate more complex conditions first. Join results concatenate the selected outputs in the configured order with deterministic path labels and blank-line separators.

Agent work uses the existing canonical Request system. Completing a provider Run or writing ordinary output does not complete a workflow step: the Agent must complete its assigned Request. Persistent Agents belong to this Branch through their Chat and retain their living history. They are managed and manually usable inside Branches; they do not appear in Dev. Temporary templates use tracked creation; all owned descendants count toward the execution’s resource budget. Their identities and audit records remain available after archival.

## Human decisions and recovery

A human gate pauses its path. Approve the proposed text, edit it when allowed, choose a configured option, or reject it. Decisions use revision checks and durable idempotency receipts. A stale decision is rejected rather than applied to changed state.

Failure policies can stop the path, retry a known failure with a bounded delay, ask a human, or ask a recovery Agent. An outcome-unknown attempt never automatically repeats potentially completed external effects. Inspect its evidence and reconcile those effects before choosing Retry. An unknown Script can instead receive an explicitly observed success/failure result.

Skip and Merge retain the source execution’s history and drain its authority. Merge identifies the surviving execution; it does not silently concatenate or alter that execution’s input. Cancel fences owned work, drains Script/provider/browser processes, and waits for observed cleanup. Temporary organizations’ delegated work is included; unrelated persistent-Agent obligations are preserved.

The built-in **Notify me** Action creates a Ponderosa notification using its input. A durable dedupe identity prevents duplicate notifications after a checkpoint interruption, including notifications already dismissed. Delivery failures remain visible and retry the same identity after lease expiry. This release does not include a speculative external-service Action catalog or credential store.

## Automatic intake

Schedules, signed webhooks, and filesystem events use the existing trigger infrastructure. Each occurrence pins the accepted workflow version and bindings. Duplicate occurrence identity does not create a second execution. Pause intake from Executions; changing trigger configuration goes through deployment.

A webhook deployment returns its signing secret once. Save it at the sender. A lost secret can be rotated in Executions. Export and deployment replay never disclose it. Send JSON to `/api/trigger-webhooks/<trigger-id>` with:

- `x-ponderosa-event-id`: stable sender event identity.
- `x-ponderosa-timestamp`: Unix time in seconds.
- `x-ponderosa-signature`: `v1=` followed by the hexadecimal HMAC-SHA256 of `<timestamp>.<event-id>.<exact request body>`, using the signing secret.

A filesystem trigger captures bounded change metadata and provenance inside the Branch’s configured working directory; it never automatically injects watched file contents. Oversized trigger payloads become explicit occurrence references, accessible only through the attached execution’s canonical Request/Run lineage.

## Versions, portability, and history

**Export template** creates a `ponderosa.branch-installation.v1` package with the graph, persistent Chat and Agent definitions, Scripts, trigger configuration, parameter declarations and limits. **Export full** also includes portable Agent history/state and normal configured parameter values. Neither exports secrets. Destination Engines, source directories and called Branch installations are chosen locally during import.

**Import workflow** always creates a new installation with new local resource identities. **Update from package** targets the selected Branch. Review the concrete before/after values, resource creation, preservation, and removals before confirming. Exact logical identities preserve Agent history; there is no fuzzy matching. Removed Chats and Agents disappear from new work immediately and are deleted after older executions drain. Settings shows pending cleanup and retryable errors. Source folders are preserved.

**Parameters** stores installation-wide values independently of the workflow definition. Use `{{parameter:name}}` in instructions, graph text, working directories and trigger configuration. Scripts receive normal values as JSON in `PONDEROSA_PARAMETERS`. Paths never implicitly load files. Secret declarations require explicit Engine-owned integration support; arbitrary prompts and Scripts cannot receive secret bindings, and there is no generic credential-entry/store feature.

A Branch Call sends explicit text, waits for one child execution and follows its own success, failure or canceled route. It uses the child's current definition and local configuration at admission. Disabling the child's trigger does not prevent calls; disabling the Branch makes callers wait durably. Cancellation propagates only through the owned execution tree.

Loops create new Step invocations. Retries reuse the same invocation and temporary Chat unless **Fresh context** is enabled. Branch limits include inherited depth, aggregate loop traversal, and graph traversal budgets across calls. Exceeding a limit produces explicit failure evidence and runs the configured failure handling.

Workflow lists, versions, execution lists, and execution evidence are bounded. Search to find a Chat, Agent, or workflow; explicitly load older history when needed. Execution graphs and results use the pinned version rather than the currently deployed definition.

## Host and release operations

Branches uses subscription-backed Codex and Claude adapters. It introduces no API-key integration, second scheduler, or independent Run authority. Scripts and Actions are operations supervised by the existing scheduler, not provider Runs.

Script process recovery currently supports Linux and macOS. Windows Script execution fails visibly before launching; Windows qualification is outside this release. The host account’s filesystem/shell authority is intentional. Workflow approvals govern workflow order and are not a sandbox for other host activity.

Back up canonical project files, journals, and SQLite state together before upgrading. Apply the normal dependency-ordered build and database migration startup. Stop the server gracefully and observe shutdown completion. Never downgrade an already migrated data directory to an older binary; restore a consistent backup to roll back. No production deployment is performed by the qualification preview.
