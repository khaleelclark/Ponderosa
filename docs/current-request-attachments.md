# Current Request attachments

A Run keeps its historical activation attachments even when steering input was
never delivered. History alone does not make that Request current work for the
old Run.

`currentRequestAttachmentSql` in `coordination-v3-request-lineage.ts` is the shared
eligibility rule. It excludes an attachment only when at least one prompt
injection contains that exact activation on that exact Run and every such
injection is cancelled with no `submitted_at`, `acknowledged_at`, or
`provider_turn_id`. It does not infer non-delivery from an activation state, a
provider message, a different Run, or a different activation in the same batch.

An attachment with no matching injection remains eligible because its delivery
is ambiguous. Pending, submitted, acknowledged and outcome-unknown injections
remain eligible. A cancelled injection with submission or acceptance evidence
also remains eligible. One such matching injection is enough to retain the
attachment even when another matching injection was cancelled before submission.
The conservative rule intentionally does not release submitted input merely
because a later refusal cancelled its injection.

The rule is used by:

- The Run Request read model, which supplies ordinary update authorization,
  attached-Request shorthand, questions, Join continuation capture, requester
  routing, streamed Request publication and provider-input Request manifests.
- The special late-result update authorization, retaining its original Run,
  fence, actor and outcome-unknown requirements.
- Normal Run completion, for direct Request/update sources and Join continuation
  sources. Failure and cancellation settlement keep their existing behavior.
- New-recipient-Request detection and Request reply timing, so those projections
  do not treat a cancelled unsent attempt as current work or its reply origin.

No activation, attachment, injection, Request update or prior outcome is removed
or rewritten. Historical lineage and rollover/recovery evidence queries remain
historical; they do not acquire a second current-attachment authority. Caller
identity, Run/fence ownership and Request recipient checks remain required.

## Parent Requests waiting for child work

Normal completion already collects direct Requests in `waiting_dependency`,
then applies `requestOwnsViableDependency` to the combined direct and Join-derived
Request list. A live owner and an unexpired open Join listing that exact Request
as a continuation protect it, with matching Project and Conversation. A terminal
Join can also protect it while its terminal activation is still pending or
retry-pending. Creating a Join moves open/in-progress continuations to
`waiting_dependency` through the existing Request update authority.

The direct-query inclusion of `waiting_dependency` therefore does not by itself
lose an open child Join. No separate defect was found in this bounded source
inspection, and this patch does not change those dependency rules.

This is a source change only. It does not establish what happened in any reported
production Run and does not restore, replay or settle old unknown effects.
