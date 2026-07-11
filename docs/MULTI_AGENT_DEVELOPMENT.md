# Multi-Agent Development

These conventions keep concurrent Ponderosa changes independently reviewable.

## Branches, worktrees, and PRs

Fetch first, then create a dedicated branch and worktree from the remote base:

```bash
git -C /path/to/ponderosa fetch origin
git -C /path/to/ponderosa worktree add -b agent/<workstream> /tmp/ponderosa-<workstream> origin/master
```

Never edit another agent's worktree, reuse its checked-out branch, commit secrets,
or mix unrelated cleanup into a feature PR. Use intentional commits and open a
draft PR early with scope, dependencies, migrations, validation, and rollback.

## Overlap detection

Before implementation and again before rebase, compare proposed paths and diffs:

```bash
git diff --name-only origin/master...HEAD
git diff --stat origin/master...HEAD
```

Explicitly flag overlap in shared contracts/events, migrations/schema/projectors,
`apps/server/src/app.ts`, web API/hooks/composer, tests, `SPEC.md`, and operator
docs. Same-file overlap is not automatically unsafe; incompatible ownership or
semantics is. Agree which PR owns the shared contract and make consumers depend on
it rather than independently inventing shapes.

## Dependencies and rebases

Prefer independent branches from `origin/master`. If feature B truly requires
unmerged feature A, branch B from A, state `Depends on #A` in its PR, and review
only B's range (`A...B`). Merge A first, then the B owner rebases B onto updated
`origin/master` and force-pushes only with `--force-with-lease`.

The branch owner owns routine rebases and local conflicts. Do not rebase or rewrite
another owner's branch without an explicit handoff. Record migrations and API/event
contract changes in the PR so downstream owners can adjust deliberately.

## Conflict resolution and integration ownership

Resolve conflicts by preserving current invariants and agreed semantics, not by
choosing one side mechanically. The integration agent:

1. Maintains the dependency graph and recommended merge order.
2. Confirms each branch is based on the expected merged prerequisites.
3. Owns cross-workstream conflict decisions after consulting feature owners.
4. Verifies migrations, event compatibility, generated lockfiles, docs, and UI/API
   contracts as an integrated set.
5. Runs clean install, typecheck, build, tests, deterministic E2E, phone checks,
   backup/restore, deployment smoke tests, and rollback rehearsal as applicable.
6. Records merge/deploy/rollback SHAs and stops integration on data-loss, security,
   or invariant failures.

Feature owners remain responsible for correctness within their scope. Reviewers
must distinguish what is on `master`, what exists only in the PR, and what remains
deferred.
