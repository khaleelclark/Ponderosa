# Agent working-copy boundary

The implemented slice resolves one durable Agent working-copy identity before a
Run claims provider execution. That resolved root supplies provider cwd,
provider-session compatibility, command sessions, file-change capture, Agent
review, current-file reads, and relative file imports. Shared remains the
explicit default; Separate Git is opt-in and an unavailable Separate copy blocks
execution instead of reverting to Shared.

This is host filesystem organization, not a sandbox. Provider processes retain
the Agent's configured host authority. Project-level browsing and provider
discovery intentionally continue to use the Shared folder for non-code and
tightly coupled Project work.

## Deferred projection checkpoint

A broader checkpoint should persist the exact resolved working-copy identity on
the scheduler Run at admission, then carry that immutable value through crash
recovery and every derived projection. Recovery must verify the same root and
Git metadata before resuming; it must not recompute a new root from current Agent
settings. That change belongs with a scheduler schema/version plan and a full
recovery audit, not this narrow vertical slice.

## Deferred provider-executor boundary

The provider executor should eventually receive a single immutable execution
scope containing the resolved working copy, session contract, process authority,
and artifact authority. Replacing its existing arguments piecemeal would be a
broad executor rewrite. Until that work is designed and reviewed, the current
slice passes the resolved identity explicitly and includes it in the provider
session contract hash.

Separate-copy removal, branch integration, and automatic conflict handling are
also deferred. Switching back to Shared leaves the managed Git worktree intact;
Ponderosa never deletes or merges it implicitly.
