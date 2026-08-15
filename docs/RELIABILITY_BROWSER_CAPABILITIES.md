# Ponderosa reliability and browser capabilities

This document describes the reliability and browser-capability contract introduced in this change. It is an operational guide, not a compatibility layer.

## Scheduler containment

Activation prompt compilation happens after a Run has been durably leased but before any provider prompt is injected. Failures in that preparation boundary are classified rather than allowed to strand the Agent or poison the scheduler loop.

- Correlated result material is resolved by durable provenance. Exact artifacts must match the recorded artifact ID, media type, byte length, and SHA-256 digest.
- A lossy preview is never substituted for a required exact artifact.
- Known compilation failures use typed codes: `exact_artifact_contract_mismatch`, `correlated_artifact_unavailable`, `activation_payload_too_large`, and `activation_prompt_invalid`.
- The preparation watchdog converts preparation exceeding 30 seconds into a typed, non-retryable compilation failure.
- The offending Activation is terminalized as a permanent failure in the same SQLite transaction that fails and fences the pre-injection Run.
- Other Activations attached to that Run return to `retry_pending`; they are not discarded with the malformed Activation.
- Unexpected pre-injection failures use the existing retry path and remain explicitly confirmed as not executed.

Scheduler metrics expose `compilationFailures`, `poisonActivations`, `preInjectionRecoveries`, and `activePreparations` alongside dispatch counts and latency. A growing poison count indicates malformed durable work. A nonzero `activePreparations` value is normal while compilation is in flight, but a sustained value combined with no accepted or rejected Runs indicates a preparation-path problem.

## Run health and delivery lifecycle

SQLite remains authoritative for Run ownership, leases, fencing, prompt-injection state, and terminal state. Health and delivery projections now derive from that durable lifecycle.

The projected runtime states are:

- `preparing`: a Run is durably leased and Ponderosa is compiling or recording the exact prompt, before provider submission.
- `running`: the provider has accepted the Run or prompt injection has advanced beyond the pre-injection boundary.
- `retrying`: delivery failed in a retryable way and remains scheduled.
- `idle`: there is no authoritative live Run or actionable Activation.

A leased or pre-injection Run is never reported as idle. Delivery receipts distinguish preparation, provider start, and retry instead of using one optimistic status. Readiness still answers whether Ponderosa can safely serve work; it does not promise that every optional provider or browser capability is available.

## Multi-page browser sessions

Browser sessions use an opaque Ponderosa page ID registry. Chromium target IDs, CDP session IDs, host paths, and filesystem locations are never returned through the public API.

- Popups and newly opened tabs are registered automatically.
- The active page is explicit and can be switched or closed.
- Closing the active page selects a safe surviving fallback.
- A session supports at most eight managed pages. Excess popups are closed and recorded as a page-limit action.
- Page actions are serialized and checked against the session generation, page identity, control owner, and control epoch.
- Control transfer invalidates pending user interactions, including file choosers.
- When multi-page support is disabled, the session retains its existing single-page behavior.

Audit actions include page open, activation, close, and limit events. Public page information contains only the opaque page ID, sanitized URL/title, opener relationship, active/new state, and whether the page is closable.

## Managed artifact uploads

Browser uploads attach an existing managed Project artifact to a file input. The browser never accepts an arbitrary host path from an operator or Agent.

Supported inputs are PDF, DOCX, and plain-text formats, with a 10 MiB maximum. The server resolves the canonical artifact, checks Project authorization, verifies the recorded size and SHA-256 digest, validates the media signature, sanitizes the filename, and stages a restrictive private copy. Chromium receives only that staged path over the private CDP connection.

The server supports two flows:

1. Explicit upload: an operator supplies a managed artifact and an optional file-input selector.
2. Intercepted chooser: Chromium reports a file chooser, Ponderosa exposes a safe pending-chooser projection, and an operator selects a managed artifact without supplying a selector.

Pending chooser state is bound to the page, browser lifecycle generation, control owner, and control epoch. It expires after 60 seconds and is cleared on selection, explicit cancellation, navigation of its frame or top page, page switching or closing, control transfer, or session shutdown. Multi-file choosers fail closed because this version only guarantees one exact managed artifact per operation.

Every successful upload records a sanitized receipt with the artifact ID, safe filename, media type, byte length, page ID, actor, and timestamp. It does not record the staged or canonical host path. Failed or ambiguous assignment removes the staged file. Retained staging directories are removed when the browser session closes, and startup cleanup removes abandoned managed upload directories from previous processes.

## API and UI behavior

Project-browser and Agent-run browser APIs expose the same page, chooser, upload, and control model. The shared browser UI provides page tabs, page switching and closing, operator control transfer, explicit managed-artifact upload, intercepted chooser status, and chooser cancellation.

If an Agent owns browser control when a chooser opens, the operator sees the request but cannot select a file. Taking control cancels the stale chooser as part of the control-epoch transition; the operator can then repeat the page action under the new epoch. This prevents a chooser created under one principal from being completed by another.

## Feature flags and rollout

- `PONDEROSA_BROWSER_MULTI_PAGE=1` enables managed multi-page sessions outside development.
- `PONDEROSA_BROWSER_FILE_UPLOAD=1` enables managed artifact upload and chooser interception outside development.
- Development enables both capabilities automatically.
- Production and other non-development environments leave both capabilities disabled unless explicitly enabled.

Recommended rollout:

1. Deploy with both flags unset and confirm scheduler metrics, readiness, and ordinary single-page browsing.
2. Enable multi-page support and watch page-limit actions, browser session failures, and process resource use.
3. Enable file upload only after artifact storage and browser staging locations have appropriate disk quotas and permissions.
4. Roll back either browser capability by removing its flag and restarting Ponderosa. Existing durable communication and Run state are unaffected.

Do not expose the browser debug port beyond the host. Do not broaden the supported upload types without adding a format-specific validator. Do not treat JSONL telemetry as authority for scheduling, browser ownership, or delivery state.\n