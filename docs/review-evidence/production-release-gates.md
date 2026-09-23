# Production release gates after PR #561

PR #561 is a remediation candidate, not production sign-off. A green PR build,
healthy development sandbox, or authenticated provider is not a substitute for
the evidence below. The release operator must record the exact commit and
artifact digest alongside each result before creating a production tag.

| Gate | Accountable role | Due | Required evidence |
| --- | --- | --- | --- |
| Ubuntu 24.04 x64 installed lifecycle | Release operator | Before production tag | Exact-commit `.deb` installed, restarted, uninstalled; lifecycle report `releaseQualified: true` and Sigstore provenance verified. |
| Provider reachability | Provider operator | Before production tag | Installed qualification includes a reachable provider observation no older than five minutes, its source, timestamp, kind, and sanitized failure category. Login and intake alone fail. |
| Maximum-size import memory | Server maintainer | Before production tag | Concurrent near-96 MiB import rehearsal, peak process/worker RSS, no OOM, staging-capacity and recovery results. The present codec still materializes a full payload in both processes; do not waive this by citing serialized admission alone. |
| Production-scale startup and shutdown | Storage maintainer | Before production tag | Representative multi-GB, long-lived history; measured cold start, write-active graceful shutdown, checkpoint rebuild, restart, and maximum RSS. The existing 9 MiB CI fixture is insufficient. |
| Installed PWA dirty-state upgrade | Web maintainer | Before production tag | Browser-level controller change while a form is dirty and while a mutation is in flight, followed by safe convergence; no lost edits and no reload loop, including delayed same-build identity. |
| Metrics and alert routing | Operations maintainer | Before production tag | Reachability and browser/process-cleanup duration/failure metrics scraped from the installed service; alert rules firing to the intended operator. A local `/api/metrics` response alone is not proof of a live scraper or Alertmanager delivery. |

## Manual merge fence while GitHub branch protection returns 403

The release operator must not use an unchecked direct merge. Immediately before
merging, record the PR head SHA and base SHA; confirm the PR is mergeable and
both exact-head checks named **Verify** and **Release recovery checks** are green;
record an independent approval for that same head. Re-read the PR head SHA
after these checks and again immediately before merge. If it changed, repeat
review and both checks. Merge only the reviewed head and verify the resulting
merge commit contains it. This procedure is mandatory until branch protection
is available; it does not itself constitute production qualification.

No release operator may mark this audit closed while any row above lacks its
exact-artifact evidence or an explicit, recorded risk acceptance from the
product owner. Development deployment does not clear a production gate.
