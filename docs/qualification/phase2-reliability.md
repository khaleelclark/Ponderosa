# Reliability qualification and remaining portability work

## Notification regression

Ordinary Agent responses and broadcasts default to quiet unread activity. Quiet metadata is durable in the workspace event log, keyed by canonical Communication identity, and separate from notifications and push delivery. The existing projection returns `quietUnreadCount` for requested Chats and folders; this count makes Chat titles bold and does not enter alert badges or notification totals. Read-visible acknowledges the exact Communication IDs with the existing product-ownership check. Preferences explicitly saved by the user remain authoritative.

The regression fixtures use controlled inert providers and disposable canonical stores. Core and Branches each emit 30 replies across three Agents. Checks cover zero default alerts, exact quiet unread counts, restart persistence, read-visible clearing, and Branches/Core isolation. Core additionally checks opt-in direct response alerts and saved settings after restart. No real provider account is used.

## Independent unread correction

Enabled response categories now retain quiet unread metadata even when Chat or Agent alert modes suppress the alert. Projection quiet counts exclude identities already represented by allowed unread alerts. Search counts and read-visible acknowledgements deduplicate canonical Communication IDs. The unread index includes suppressed informational alerts, allowing exact visible reads to clear them before a later mode change. Badge and push selection remain on the existing alert policy path.

Supported API regressions cover muted and attention-only modes at Chat and Agent scope in Core and Branches, restart, product-isolated acknowledgement, folder counts, search counts, repeated IDs, and a reply arriving after a visible snapshot. Existing Core and Branches 30-message default bursts remain part of focused verification. These checks do not establish a full commandment 18 pass: the complete mentions/settings matrix and browser visual qualification remain outstanding.

## Portability remains incomplete

Full Agent v1 packages now retain persisted normalized execution events and scheduler Run summaries as versioned managed log artifacts. Full organization exports do this for each included Agent; Branches Agent packages use the same path. This is an execution-evidence slice, not complete portability: local-memory chunks, provider-native sessions, exact provider-input records and historical Branch execution Chats remain omitted. The full-export dialog warns that history and stored data may contain sensitive information; known credential fields remain outside the schema. This warning does not establish full portability.

Execution archive export and import share `portable-secrets.ts`: known structured credential fields (including recognized OpenAI, Anthropic/Claude, Codex, Azure OpenAI, Google/Gemini, AWS and Ponderosa VAPID environment fields) are removed on export and rejected on import before destination Agent/artifact mutation. Valid JSON object, array and string encodings are inspected recursively. Safe string bytes, Unicode and free-form prose are preserved. Inspection is limited to 64 nesting levels and a cumulative 64 MiB budget including decoded strings; excessive nesting or bytes fails explicitly. Each exported archive is checked by the same validator before publication, so export cannot emit an archive that exceeds its import inspection bounds. The 64 MiB archive envelope cap is checked before UTF-8 decoding/JSON parsing. This policy does not guess secrets in arbitrary historical prose; the sensitive-data export warning remains necessary. Metadata callers can use `assertPortableSecretsAbsent(metadata, label)` to reject rather than scrub. Historical `SourceStamp.fenceToken` is permitted; it is not treated as a credential field. Keep free user-authored memory text outside metadata validation.


Complete the omission fix through one shared migration path:

1. Add a versioned portable memory snapshot with exact text, metadata, embeddings, supersession/conflict history, visibility and source provenance. Include Chat memory once per Chat and explicitly define global-memory inclusion. Rebind installation/Chat/Agent authority through the host service; never copy the source installation principal or credentials.
2. Retain the new execution archives in Files & Results through the existing managed artifact import/re-export path. They contain original source identities, persisted event payloads and timestamps, plus Run identities/status/times. They never enter destination Work log, Requests, Runs, activations or outboxes as live authority. Extend coverage to provider-native sessions, exact provider inputs and Branch execution history before claiming identical recreation.
3. Extend the shared strict parser and size accounting before mutation. Extend the durable import operation to stage, commit, recover and roll back memory and execution archives together with Agents/artifacts. Cover retry, cancellation, destination deletion and crash windows. Branch imports and updates must use the same path and retain stable external references.
4. On separate fresh disposable Core and Branches stores, seed public/private Chat memory, execution output, a completed Run and a representative workflow; round trip and reopen. Compare every field after explicitly documented destination identity remapping. Assert known secrets absent and the export warning visible. Repeat the import to verify idempotency without duplicate memory or history.

## Upgrade and repetition plan

First integrate reviewed fixes into one pinned candidate. Build all workspaces, run the full repository test runner once, retain failures/skips, and fix failures before any streak attempt. Do not count isolated lane checks as a full core-path pass.

Upgrade separate populated disposable Core and Branches stores from the previously audited ui096 build to the integrated candidate using the actual startup/migration path. Preserve old and upgraded copies. Compare Agent identity/settings, organization edges, Chat messages/instructions, artifacts, memory chunks/ownership, historical execution output, Branch definitions/bindings/triggers and pending coordination outcomes. Use no real credentials or paid provider calls. Then run controlled messaging, handoff and restart flows on the upgraded stores.

Only after integrated fixes and upgrade qualification pass, run the complete controlled core-path suite 20 consecutive times with a fixed source commit, command, environment and manifest. Retain every run's output and skips. Any failure breaks the streak; identify and fix it, then restart. Provider-backed or external checks skipped by the suite remain unverified and cannot be presented as passing.

First-run timing starts with the installer downloaded and a provider already signed in. Use a fresh disposable user environment and the published docs; record each step through the first reply. Missing authorization must be supplied by the operator and cannot be bypassed. Phone/provider-only checks go on the operator handoff checklist without blocking independent source fixes.

## Controlled suite prerequisites

Build every workspace used by the selected lanes, including `@ponderosa/launcher` and `@ponderosa/engine-desktop` for tooling. Tests that launch Chroma require `PONDEROSA_TEST_CHROMA_BIN` and `PONDEROSA_TEST_MEMORY_MODEL_DIR` pointing to the existing pinned local dependencies; they start their own disposable process and collections. Use `TMPDIR=/tmp` for owned fixtures. Packaged-mode preservation fixtures explicitly establish `0755` on their own disposable executable files before testing preservation, so they also run under a restrictive `umask 0077`; product permissions are unchanged.

The host-identity lifetime test temporarily clears and restores `PONDEROSA_VAPID_PUBLIC_KEY`, `PONDEROSA_VAPID_PRIVATE_KEY` and `PONDEROSA_VAPID_SUBJECT` inside its disposable test process. It must generate its own local identity rather than inherit an operator-managed override; no caller environment cleanup is required. Do not print, copy or publish the operator's values. Keep all initial failures and focused corrected reruns in the evidence; a passing focused rerun does not turn an earlier failed whole-suite command into a passing whole-suite result.
