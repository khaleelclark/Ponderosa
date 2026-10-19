# Claude history retrieval qualification

Q12 exposed a dispatch gap: the selected `ponderosa_history` definition was advertised to Claude, but the MCP bridge had no history URL. The provider executor now supplies the existing `/api/agent-history` endpoint and the bridge routes the selected tool there. Claude's existing child environment inheritance carries that URL; no adapter or authorization redesign is needed.

`tests/context-recovery/claude-history.test.mjs` runs the actual MCP bridge over stdio against the actual HTTP route and SQLite communication history. It uses owned fixtures and a fake capability-authorized active Run, without provider inference. It verifies:

- Bounded old-fact search, `hasMore`, exact canonical text and a five-message authorized neighborhood.
- Frozen cutoff and recent-tail exclusions, foreign Agent/project refusal, current Run/token/tool/boundary requirements, malformed requests and search/read bounds.
- Missing URL/token/selection refuses access without falling through to another endpoint.
- Claude's actual persistent-session class launches a local fake executable which starts the configured MCP bridge, inherits the issued environment and retrieves an old fact. That executable test requires POSIX and a whitespace-free Node executable path; other boundary checks are portable.
- Codex's existing direct dynamic-tool handler returns the same canonical message and rejects revoked authority too.

Every owned test process is awaited before fixture cleanup. Failed fixtures are retained. These checks exercise a replacement-style frozen history capability; they do not claim real Claude/Codex model behavior, provider-driven compaction, account access or a physical desktop installation.

Run after building the engine/server workspaces:

```sh
node --import ./tests/shared/workspace-resolution.mjs --test tests/context-recovery/claude-history.test.mjs
```

Q10 is reconciled without another parser change. The existing eight `tests/providers/capabilities.test.mjs` checks pass: configured/disabled state, supported transport tables, malformed inventories, diagnostic prose, failed ordinary/managed subprocesses and cancellation with observed root exit. Discovery remains configuration evidence, never proof that a connector is usable.
