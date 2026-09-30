# Ponderosa UI audit remediation — one-PR specification

Reference audit: September 29, 2026, development build `96445032a84d11de8c45cdb9354430dc873fedd5`.

Implement F01–F34, sent-attachment retention and reconciliation (A01), and sidebar Chat-message search (S01) in one pull request. The objective is accurate review and preview behavior, durable access to sent Chat attachments, predictable navigation and search, and clear feedback throughout the existing interface. Revalidate the implementation base against current `master` before starting. Keep a finding-to-change-to-test checklist in the PR description so every audit item and added requirement has a verifiable disposition.

This spec also includes the audit's outage-state observations and a bounded investigation of the browser reliability observation. Source inspection, automated browser checks, and actual end-to-end observations must be distinguished in the final verification report.

## Product rules

- A label must describe the state or destination it actually represents. Loading, unavailable, empty, successful, cancelled, and unconfirmed states must remain distinct.
- Show feedback where the user initiated the action. Downloads say **Download started**, because the application cannot generally confirm that the browser wrote a file to disk.
- The operator's sidebar identity becomes `#thop` (or the current handle). Do not add mention-explanation helper text to the sidebar, composer, messages, menus, or notifications. Keep a concise description in Profile settings explaining `#` for Agent/user mentions and `@` for file references. This restriction concerns mention guidance; validation errors and actionable failure messages still belong beside the affected control.
- Preserve the compact composer and existing message-action spacing. Do not expand touch targets or change unrelated layout as incidental cleanup.
- Keep bounded queries, pagination, request cooldowns, file-access authorization, preview safety, and cancellation fencing. Fixing a label or display must not change canonical communication scope, delivery acknowledgement, or Run outcome.
- Reuse shared previews, download handling, effective-setting resolution, navigation context, and feedback components where those facilities already exist. Avoid parallel implementations for Chat and Agent surfaces.
- Retain the current safety fallback for unsupported media. No new document-rendering dependency is required.

## Review and file correctness

### F30 — Real Git patches

Generate actual staged and unstaged patches against their correct Git bases. The staged patch compares HEAD with the index; the unstaged patch compares the index with the working tree. Present these as clearly identified sections when both exist. A modified tracked file must include removed and context lines. A deleted file must show the text removed from its base even though there is no current file to read.

Only genuine new/untracked files receive an added-file patch from `/dev/null`. A trailing newline must not create an extra added blank line. Renames, binary files, oversized patches, and repositories without HEAD must receive accurate bounded handling rather than a fabricated patch or an assertion that no changes exist.

Preserve the secure file-root and Git metadata checks, path exclusions, output/time limits, and protection against external diff programs, text conversion, hooks, or configuration executing code. Detect incompatible repository/file changes during capture and offer refresh instead of presenting mismatched status and content.

Acceptance: compare the server response with Git for tracked edits, staged edits, a staged edit followed by an unstaged edit, staged/unstaged deletions, untracked additions, newline/no-newline files, renames, and binary/truncated cases. Include ordinary repositories and managed separate Git copies. Prove out-of-scope paths and changed-root fixtures remain rejected.

### F02 — Review contrast

Use theme-aware selected-row foreground/background colors and readable added/deleted text in both themes. Secondary metadata inside a selected row must inherit an appropriate contrast color. Verify normal-sized text meets 4.5:1 contrast for the resulting colors; retain visible non-color indicators for addition/deletion.

### F03 — Mobile review navigation

At phone widths, selecting a file opens its diff/current-file view immediately, with an obvious Files control to return to or change the selection. Do not put an unbounded recorded-file list above the diff. Desktop retains its split view. Preserve selection and mode across refresh where the file still exists.

Acceptance: select the first, middle, and last entries in a 75-file recorded review at 390px. The selected content is reachable immediately without scrolling through the list; file switching, back navigation, and horizontal code scrolling work.

### F09 — Review scope

A message's changed-files entry carries its canonical Run/execution context and return destination into review. Offer clearly labeled **This response** and **Working folder** scopes where both are available. The message entry opens its recorded response changes; the general Agent Review action opens the current working-folder review. If only accumulated recorded history is available, label it **Agent change history**.

Recorded response changes must not be represented as the current Git working-tree patch. Counts must belong to the selected scope. Do not attribute shared-folder changes to an Agent merely because it can see them.

### F04 — Complete, identifiable file search

Search the available Chat file/result catalog through a bounded server query instead of filtering only the pages already loaded. Include accessible working-folder file matches in the same search, using existing scoped file-search authority. Distinguish managed results from working-folder files. Do not eagerly load all history or recursively scan unrestricted host folders.

Every global Files result and review row must expose a useful relative path and containing Chat/working-folder identity. Preserve private absolute paths for authorized technical details rather than placing them in ordinary labels. Where an external path cannot safely be presented, show a distinguishable safe label and provenance instead of dropping all entries to identical basenames.

Counts must say whether they describe loaded items or returned matches. If a bounded search is incomplete, represent that explicitly through pagination or a concise result-state indicator; do not claim there are no matches in unsearched data.

Acceptance: older matches appear without manually loading older pages; duplicate README files can be distinguished before opening; pagination preserves scope; another Chat's private results remain excluded.

### F10, F31 — Consistent image/PDF previews

Use the shared safe preview path for supported images, PDFs, Markdown, and text in both the live Workspace Files modal and standalone viewer. Keep DOCX and other unsupported types as honest download fallbacks.

Allow verified PDF preview responses to be embedded by Ponderosa's own origin. Apply the exception specifically to the appropriate preview responses and preserve isolation and restrictive policies for other content. Verify the rendered PDF frame; HTTP 200 alone is insufficient.

### F32 — Relative Markdown images

Resolve relative image paths against the document's actual authorized working folder and directory, including separate Git copies. Use the scoped media-preview endpoint as the image URL. Do not point image sources at application file-viewer routes or resolve them against the current page URL.

Reject traversal, malformed encoding, unsupported schemes/media, and out-of-scope paths. Preserve valid Markdown anchors and current external-link behavior. Show a readable unavailable-image state when a local target is missing.

Acceptance: nested relative images render with nonzero natural dimensions; valid links still work; escaped traversal and malformed paths never request files outside the scope.

## Downloads, navigation, and diagnostics

### F01 — Transcript export and download feedback

Repair the transcript download lifecycle in the tested embedded browser and qualify it in a normal browser. Use shared download handling where practical, retain object URLs long enough for the browser to consume them, and clean them up without leaks. Immediate revocation is a suspected cause to test, not an assumed diagnosis.

Show a three-second **Download started** snackbar once the download has been handed off. Request or preparation failures receive an actionable error and must not show success. Apply the feedback consistently to transcript, package, artifact, and workspace downloads. Preserve transcript authors, text, attachment references, and filenames.

Acceptance: a download event/file is observed for Chat and Agent transcripts; package/artifact downloads continue to work; injected failure produces error feedback without a false success notice.

### F05 — Correct return destinations

Preserve the route and context from which the user opened Review, Automation details, or a standalone file. Back returns there and names the destination accurately. A direct deep link uses a stable sensible fallback, such as the Automations directory for an Automation, rather than depending on arbitrary browser history.

Acceptance: Chat → Review → Back returns to the same Chat; Agent → Review → Back returns to that Agent; global Automations → detail → Back returns to Automations; file viewer returns to its originating file/results view.

### F06 — Explain the exact failure first

Resolve diagnostic focus by exact record ID and kind before matching related reference IDs. Highlight and expand the failed Request or Run named by the notice. Related successful wake-ups and other provenance remain secondary. The first explanation must state what requires attention in plain language and link to the relevant evidence.

Acceptance: a failed Request with many related records lands on that Request even when an earlier successful wake-up references it. The full workflow remains inspectable.

### F11 — Browser naming

Use the current Chat name in the browser title and workspace picker, with folder/working-folder context where names collide. Renames update the display. Preserve the actual browser/session association; a display-name fix must not attach the user to another session.

### F12–F15, F19 — Provider state and settings clarity

- **F12:** Provider attention has a reason and a link to the relevant provider controls. Distinguish provider attention from work awaiting a user response so Home does not appear to contradict itself.
- **F13:** Explain that Provider Activity contains per-Run telemetry, while the usage popover may retrieve provider-account limits. Remove blanket claims that Ponderosa cannot read subscription quotas when a supported provider supplies them.
- **F14:** Label defaults by their source, such as provider/host default and saved defaults for new Agents. Show effective settings using the same resolution rules as runtime submission. Verify the actual precedence rather than inventing a second frontend hierarchy.
- **F15:** When sign-in data exists but the access check was rejected, lead with the access problem. Explain that sign-in information was found but the provider rejected the check, instead of showing unqualified green Signed in/available claims beside the failure.
- **F19:** Loading is a pending state. Do not manufacture `unknown_failure` because a refresh has not yet supplied a reading. Keep a last successful reading available with accurate freshness; show failure diagnostics after an actual completed failure.

Acceptance: healthy, pending, disabled, rejected-access, stale-reading, and failed-refresh fixtures render distinct truthful states; displayed effective defaults agree with the submitted runtime configuration.

## Forms, wording, and feedback

### F07 — Truthful empty states

Home's enabled-only Automation section says **No Automations are enabled** when disabled configurations exist. Show no-configurations wording only when none exist.

Search and Notifications distinguish unavailable, loading, stale saved data, and a successful empty response. Do not show No matches or All caught up when the necessary request failed. Preserve usable saved data with an accurate freshness indication.

### F08 — Profile validation

Show field-local corrections for an empty display name, invalid handle syntax, and reserved handles. The Save button may remain disabled for invalid input, but the reason must be visible. Keep the profile's mention description concise and use the rules enforced by the server.

### F16 — Save feedback

Profile and session-rollover saves show pending, saved, and error feedback beside their controls or through the established snackbar. Successful saves use specific messages such as **Profile saved**. Failed saves preserve the draft and make retry possible.

### F17 — Handle presentation

Change the sidebar identity from `@thop` to `#thop`, using the current handle dynamically. Keep `#` for Agent/user mention presentation and `@` for file references. Review profile labels and identity presentation for consistency. Add no mention helper text outside Profile settings and no new text beneath the composer.

### F18 — Searchable Activity scope

Replace the flat hundreds-item scope menu with a searchable grouped selector. Keep All Ponderosa easy to select and distinguish Chat/Agent scopes with readable context. Do not load full Agent histories to populate it. Verify keyboard and phone-width use with at least 695 options.

### F20 — Automation presentation

Show schedule prose and localized dates/time zones in the primary overview. Keep raw source JSON under Technical details. Render Destination Chat and Runs as exactly once; fixed values may be read-only in that one authoritative location. Remove obsolete Project Automation terminology where the flow is Chat based.

### F21 — Cron validation

Place a clear validation error next to the Cron field, covering the five-field format and the current minimum interval. Validate the timezone too. Keep the user's draft, consistent capitalization, and the existing scheduler limits.

### F22 — Cancellation wording

Show Stopping while termination is pending and Stopped/Cancelled after the observed termination is confirmed. Preserve provider acknowledgement of the message. Explain that work performed before stopping can remain, and retain an unconfirmed result when evidence is insufficient. Do not describe a stopped Run as a dismissed follow-up or encourage a duplicate delivery without the existing warning.

### F23 — Correct disabled-send reason

An empty draft with a selected available provider requires a message, not a provider change. Use the correct disabled-button accessible name/tooltip without adding composer helper text. Actual provider unavailability retains an accurate provider-specific reason. Check attachment-only drafts against the existing supported-send rules.

### F24 — Small consistency fixes

Correct singular/plural grammar, unify reasoning labels such as Extra high, separate pinned-model validation metadata, and convert notification Markdown to readable preview text before truncation. Preserve the original full message and link targets.

### F25 — Reachable work-output destination

Replace references to the obsolete Activity tab with the actual current destination. Provide a working link to the appropriate Work log in Chat or Technical details, carrying the relevant Agent/Run context.

### F26 — Visible Top Level selection

The organizational-parent selector displays **Top Level** when its selected value represents no parent. It must not collapse into a blank field. Save/reopen preserves the actual top-level relationship.

### F27 — Successful import framing

A completed import is presented as **Import complete**. Optional review of preserved history is an informational action, not a claim that the import is blocked awaiting a decision. Actual import warnings requiring intervention remain attention items. Reviewing or dismissing the completion notice must not alter imported canonical history.

### F28 — Duplicate Agent identity

Continue allowing duplicate display names. Where duplicates would be indistinguishable, show their unique `#handle` and useful Chat context in selectors/sidebar rows. Avoid adding identity clutter to every row when no ambiguity exists. Imported Agents retain their own stable IDs and do not overwrite an existing Agent.

### F29 — Decision response wording

Use **You answered** for text/alternative responses, **You chose** for a selected choice, and suitable approval wording for approvals. Preserve the submitted response exactly and avoid appending duplicate terminal punctuation. Determine the wording from the recorded response type, not a guess based on its text.

### F33 — Search displayed capability names

Capability search matches the visible label as well as the runtime identifier and description. Both **Review Agent** and `review-agent` find the same skill. Selection still inserts its exact runtime command. Preserve capability availability and connector/plugin behavior.

### F34 — Fresh-session action feedback

Start Fresh Provider Session shows progress, success, or error in Settings beside the initiating control. Prevent duplicate pending requests and preserve the current session-replacement semantics. The user should not need to switch to Chat to find the result.

## Additional audit observations

Reproduce unavailable-backend states with isolated fixtures. Keep navigation reopening available in the complete failure fallback. A saved-data banner appears only when usable saved data is actually being shown. Connection Details and Retry communicate the observed state without repeated generic text or raw route/debug fragments.

Exercise the reported browser history → reload → float → end-session sequence serially in a disposable browser. Separate product errors from the automation tool's own transport failures. Fix a verified product cause and add a focused regression if found. Until a cause is reproduced, do not claim the browser incident has been fixed. Browser capacity/rate-limit errors should use actionable wording and existing cooldown handling without adding retry loops.

## A01 — Sent Chat attachment retention and reconciliation

### Retention and ownership

Before deleting an Agent's storage, identify attachments referenced by canonical messages in Chats that will remain. Give those files durable Chat-owned storage and record a mapping from the original attachment to its retained copy. Keep the canonical message, attachment references, and their identities unchanged. Do not retain unsent drafts, Agent-private files, or attachments belonging only to a deleted Chat. Preserve any existing explicit sharing and authorization boundaries; retention does not make a private attachment Project-wide.

Delete retained files when their owning Chat is deleted, provided no other authorized retained Chat still references them. Reference handling and repeated cleanup must be idempotent.

### Crash-safe deletion

Verify each retained copy's size and hash before removing its Agent-owned source. Bind copy publication and mapping to the authorized storage identities, preserving cross-platform file-authority protections. If copying or recording the mapping fails, leave deletion cleanup pending with an actionable error. Never report cleanup complete while a retained Chat would lose its attachment.

Recovery must safely resume after interruption before copying, after copying but before recording the mapping, and after mapping but before source removal. A retry must not create duplicate mappings, inaccessible files, or accidental retention of private files. Distinguish the logical Agent deletion from any pending physical cleanup without reviving the Agent.

### Reads and unavailable historical files

Preview and download links in a retained Chat resolve through its retained copy with the same Project/Chat authorization as before. Integrate this resolution with the shared preview/download work in F01, F10, and F31 instead of adding a separate viewer.

When historical bytes genuinely cannot be recovered, show **Attachment unavailable** instead of a broken image or a working-looking download link. Do not mark a recoverable loading/request failure as permanent absence. Preserve the original message and inspectable attachment metadata.

### Startup reconciliation

Check whether the canonical message and required projections are already complete before requiring the original runtime attachment reservation. Completed historical messages must not produce a false uncommitted-message error on every restart merely because the original Agent reservation was removed.

Genuinely incomplete sends still fail closed when required attachment bytes are missing and are reported accurately. This change must not turn a failed send into a successful one or suppress a real missing-attachment problem in a retained Chat.

### Opt-in historical repair

Provide an audited, opt-in repair procedure for retained Chats with missing attachments. Restore only verified attachment bytes and their authorized ownership/mapping from a selected backup; verify identity, size, and hash. Never restore an entire old database over current data, revive a deleted Agent, change a canonical message, or automatically apply a repair at startup.

The three previously inspected files were present in a pre-deletion backup. Recheck backup availability and exact message/Chat eligibility before proposing a live repair: files belonging only to a deleted Chat are not eligible for retention. The PR implements and tests the repair mechanism; applying it to existing dev data is a separately authorized operation with a preview of affected records and an audit of the result.

### Acceptance

- Send an image, delete its Agent, restart: the retained Chat's preview and download still work, with unchanged canonical identities and no false startup error.
- Delete the owning Chat too: its retained files and mappings are removed; shared retained references, if supported, are not prematurely removed.
- Interrupt deletion at each copy/mapping/source-removal boundary: recovery completes without missing bytes or duplicate records. Inject copy, verification, and mapping failures and confirm cleanup remains pending.
- A genuinely uncommitted message with a missing attachment remains blocked and is reported accurately.
- Existing missing-file messages show an honest unavailable state. A disposable backup-repair test restores access without changing the message or reviving the Agent; wrong identity/hash/scope repairs are rejected.
- Cross-Project access, another Chat's private attachments, deleted-Agent private files, unsent drafts, and attachments belonging only to a deleted Chat remain inaccessible or are cleaned up as appropriate.
- Exercise the retained-storage path using the supported cross-platform authority tests; report native-platform verification separately.

This is a code fix plus an opt-in historical-data repair mechanism, not a rollback of PR #602.

## S01 — Search Chat messages from the sidebar

Typing a term such as **marketing** into the sidebar's **Search chats** field should find a Chat where it was discussed even if the title does not contain it. The sidebar stays a compact finder; global search remains the detailed results view. This requirement is distinct from F04's file search.

### Results and navigation

Keep existing Chat-name results and add a clearly labeled **Found in messages** section. Show at most five distinct Chats in that section. Each row includes the Chat title, Project context when needed to distinguish duplicate titles, and a short excerpt with the term highlighted. Multiple matching messages in one Chat must not crowd out other Chats.

Selecting a message result opens its Chat and focuses that exact canonical message, including loading older history when necessary. Selecting a name result continues to open the Chat normally. Preserve existing archive exclusions and authorization scope; exclude Agent DMs from the message section.

Provide **View more in full search**, opening global search with the term entered and the Chats filter selected. Opening global search normally keeps its existing behavior.

Do not show **No matches** until both name and message searches finish successfully. If message search fails, preserve usable name results and state that message results are unavailable. Keep pending, stale, failed, and successful-empty results distinct, consistent with F07.

### Bounded implementation

Reuse the canonical Chat-message search and highlighting. Preserve current folder, star, and sort behavior when the search is cleared. Search only while the Chats panel and document tab are visible, using the existing debounce and shared 429 cooldown. Do not add polling. Cancel or disregard obsolete queries so results for an earlier term cannot replace the current search.

The current message search scans a bounded set of recent messages. If that limit is reached, state that older matches may not be shown; neither sidebar nor global search should imply it searched all history. Measure added query cost before shipping. If it causes appreciable latency or request-limit pressure, improve the shared search path rather than increasing its scan limit. Avoid full-history or per-Chat fan-out queries to populate five rows.

### Acceptance

- A term found only in message text returns the correct Chat and opens at the exact message, including an older-history match.
- Several matches in one Chat produce one message-result row; distinct Chats remain represented up to the five-Chat limit.
- Title matches keep their existing navigation. Duplicate titles are distinguishable, archived Chats and Agent DMs are excluded, and unauthorized messages cannot appear.
- Highlighted excerpts render safely; keyboard and touch selection, loading, failure, empty, and bounded-search states work at desktop and 390px widths.
- **View more in full search** transfers the term and Chats filter; opening global search normally is unchanged.
- Rapid typing, hiding the sidebar/tab, clearing the search, and a 429 cooldown do not create stale-result races, background polling, or repeated retries.
- Measure query count and latency in a busy multi-tab workload and run the existing request-storm check. The added search must not recreate Ponderosa's request storm.

## Verification and PR completion

1. Run the repository's required local verification on Node 24, production builds/typechecks, `git diff --check`, and focused checks for the changed behavior. Do not trigger paid GitHub Actions; keep the established local verification process.
2. Test the shared UI at desktop and 390px phone widths, in both themes. Use real rendered frames, downloads, route transitions, and focus/selection behavior where the finding concerns those interactions.
3. Run the existing bounded-request regression to ensure file search, sidebar Chat-message search, selectors, and feedback fixes do not reintroduce background request storms. Preserve visibility gating and Retry-After behavior; record sidebar-search query cost and multi-tab results.
4. Verify actual staged/unstaged patches, PDF/image preview, transcript export, exact failure focus, duplicate-file identity, source-default precedence, cancellation wording, and fresh-session feedback. Run A01's deletion/restart/fault-injection and disposable historical-repair checks, plus S01's exact-message navigation and bounded-search checks. Use disposable data for mutations.
5. Record F01–F34, A01, and S01 in the PR checklist with changed files and relevant evidence. Separately list any platform or browser behavior that remains unverified; passing emulation does not establish physical-phone behavior.
6. Use one PR for this scope. Merge and deployment follow the normal review process; the PR must describe the final implementation and test results rather than implying that every audit observation was independently reproduced.

All three workstreams are included in this one-PR specification. Approval to implement the PR does not authorize restoring historical dev data, merging, or deployment; those follow their respective explicit approval steps.
