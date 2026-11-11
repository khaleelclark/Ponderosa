# Outside application driven by Branches

Install/build Ponderosa's existing `@ponderosa/core` package in this app's Node
workspace. Set `PONDEROSA_URL` and a published `BRANCH_ID`, then start `server.mjs`.
This example is source only in the implementation-first change; it was not run.

- `POST /runs`: JSON `{text, occurrenceKey}`. Reuse the key when recovering a response.
- `GET /runs/:id`: one canonical state page.
- `GET /runs/:id/actions` or `/result`: current human actions or execution result.
- `POST /gate`: `{executionId, gateId, commandKey, expectedRevision, decision, output?}`.
- `POST /runs/:id/cancel`: canonical workflow cancellation.
- `GET /stream?executionId=...&agentId=...&runId=...`: the exact current live target.

The configured workflow's existing bindings supply tools, memory and subgraphs.
Its human access settings and scheduler remain authoritative. The app does not
add a provider, grant, private-store connection or independent history.
