# @ponderosa/engines

Engine adapters + event normalization. The **only** package that knows an engine's
native event shapes (AGENTS.md invariant 2). Everything downstream speaks the
normalized `AgentEvent` union from `@ponderosa/core`.

## What's here

| File | Role |
|---|---|
| `events.ts` | **The heart of the chunk.** `mapCodexEvent(raw, ctx)` maps one Codex JSONL event → 0..n `AgentEvent`s. Unit-tested per event type + against recorded fixtures. |
| `jsonl.ts` | Robust JSONL stream parsing: partial lines across chunks, CRLF, non-JSON noise. |
| `codex.ts` | `CodexAdapter implements Adapter` — spawns `codex exec --json` / `codex exec resume`, streams events, wires `AbortSignal` → SIGTERM → SIGKILL. |
| `auth.ts` | `codexAuthStatus()` — reports whether `codex login` was done (presence of `$CODEX_HOME/auth.json`). We never read the token. |
| `harness.ts` | The CLI test harness (`pnpm engines:try`). |

## Subscription auth only — the economic premise

This adapter drives the **already-authenticated `codex` CLI**. It NEVER calls a
provider HTTP API and NEVER reads an API key (AGENTS.md invariant 1). Auth is done
once by the operator with `codex login` (browser OAuth), which stores a ChatGPT
subscription token under `~/.codex/`. That is the savings path.

## Decision: spawn the CLI directly (not the `@openai/codex` SDK)

We spawn `codex exec --json` directly rather than depend on the `@openai/codex` TS
SDK. Reasons: the CLI's JSONL contract is stable and we validated it against the
installed version; the `resume` subcommand has flag quirks (it rejects `-C`/`-s`,
so cwd is set via the child process and sandbox/approval via `-c` overrides) that
are easier to control directly; and it keeps the dependency surface minimal. The
`Adapter` interface hides this entirely — swapping to the SDK later changes nothing
outside `codex.ts`.

### How each method maps to the CLI

- `seed()` → `codex exec --json --skip-git-repo-check -c sandbox_mode=… -c approval_policy="never" [-m model] "<prompt>"`, spawned with `cwd` = the project dir. The prompt is the thread's chat history rendered minimally (no packet — SPEC §4/§5); the agent reads the repo's md files and git state from its cwd itself.
- `continue()` → `codex exec resume <SESSION_ID> --json …`, same overrides, same cwd.
- Session id = `thread.started.thread_id`, emitted as a `session` event and persisted by the thread store for resume.
- Sandbox defaults to `workspace-write` (edit the project + run commands within it, headlessly). Override with `PONDEROSA_CODEX_SANDBOX=danger-full-access` for the full-access model in SPEC §11.

## The harness

```bash
pnpm -r build                      # harness runs from dist
# fresh session:
pnpm engines:try --cwd /path/to/repo "List the files and summarize the README."
# resume the printed session:
pnpm engines:try --cwd /path/to/repo --resume <session-id> "Now add a CONTRIBUTING.md."
```

It streams pretty-printed `AgentEvent`s and prints the captured session id plus the
exact resume command. `Ctrl-C` cancels the run (exercises `AbortSignal` → kill).

## Manual verification: usage bills the ChatGPT subscription (do this on the host)

This confirms the whole economic premise (SPEC §15). On a machine where
`codex login` was completed:

1. Ensure no API key is set: `unset OPENAI_API_KEY` (there must be **no**
   `OPENAI_API_KEY` in the server's environment — the adapter never uses one).
2. Confirm login type is subscription, not API key:
   `cat ~/.codex/auth.json` and verify it shows a ChatGPT/OAuth login (an
   `OPENAI_API_KEY`-based auth would be the wrong, billed path). `codexAuthStatus()`
   surfaces presence for the UI badge.
3. Run a turn: `pnpm engines:try --cwd <a repo> "Say hello and stop."` — it should
   complete and print a `turn_done` with token usage.
4. Check the ChatGPT side: your usage should be drawn from the **ChatGPT
   subscription plan** (visible in ChatGPT settings → usage), **not** the OpenAI
   Platform API billing dashboard (which would show per-token API charges). If API
   billing moved, STOP — the subscription path is broken (SPEC §5 must be revisited).

## Tests

```bash
pnpm --filter @ponderosa/engines test
```

`events.test.ts` covers every event-type mapping plus recorded real-codex fixtures
(`fixtures/*.jsonl`). `jsonl.test.ts` covers partial-line/noise handling.
`codex.test.ts` drives the adapter against a fake `codex` (`test/fake-codex.mjs`) to
verify streaming, nonzero-exit errors, and abort-kills — no real login needed in CI.
