# VERIFY.md - Vertical Slice Release Checklist

Use this as the ordered Chunk H sanity pass. The goal is SPEC §1's v1 slice:
from a phone, reach the host, create a project/thread, start a real Codex run,
watch structured events return, and verify the log/projections/artifacts survive
real-world interruptions.

Checks marked **Manual** require a human action or visual inspection. Do not count
the slice as passing until every required check below passes against a real repo
and a real `codex login` subscription session.

Current implementation note: if Chunk F/G are not merged yet, `apps/server` may
only expose `/api/health` and `apps/web` may still be a placeholder. In that case,
complete the setup and Codex harness checks, then mark API/UI-dependent items
blocked on F/G rather than bypassing the server with direct store calls.

## 1. Setup

- [ ] **Manual** Confirm the host has Node 20+, pnpm, git, and Codex CLI:
  `node -v`, `pnpm -v`, `git --version`, `codex --version`.
- [ ] Install dependencies if needed: `pnpm install`.
- [ ] Run the package checks from the repo root:
  `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`.
- [ ] Pick an isolated data dir for the pass:
  `export PONDEROSA_DATA_DIR="$(mktemp -d)"`.
- [ ] Use a disposable real git repo as the target project, because the artifact
  checks ask Codex to make a small file change:
  `export VERIFY_REPO="/absolute/path/to/a/safe/test/repo"`.
  One option is:
  `VERIFY_REPO="$(mktemp -d)" && cd "$VERIFY_REPO" && git init && printf '# Verify repo\n' > README.md && git add README.md && git -c user.name=Verify -c user.email=verify@example.invalid commit -m init`.
- [ ] Start the server:
  `PONDEROSA_DATA_DIR="$PONDEROSA_DATA_DIR" pnpm --filter @ponderosa/server dev`.
- [ ] Confirm health from another shell:
  `curl -fsS http://127.0.0.1:8787/api/health`.
- [ ] Start the web app, binding to the LAN/Tailscale interface if testing from a
  phone:
  `pnpm --filter @ponderosa/web dev -- --host 0.0.0.0`.

Expected: build/test commands pass, health returns `status: ok`, and the web app
is reachable from the host browser before phone testing begins.

## 2. Codex Login And Subscription Billing

- [ ] **Manual** Complete `codex login` on the host with the ChatGPT
  Plus/Pro account that should fund runs.
- [ ] **Manual** Confirm the server shell does not contain provider API keys:
  `env | grep -E '^(OPENAI|ANTHROPIC)_API_KEY='` should print nothing.
- [ ] **Manual** Confirm Codex auth exists without copying secrets into notes:
  `test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"`.
- [ ] Run a live Codex harness turn:
  `pnpm -r build && pnpm engines:try --cwd "$VERIFY_REPO" "Say hello, report pwd, and stop."`
- [ ] **Manual** Verify the harness prints a session id and `turn_done`.
- [ ] **Manual** Verify billing/usage is attributed to the ChatGPT subscription,
  not OpenAI Platform API billing. If Platform API usage increments or an API key
  is required, stop: the economic premise is broken.

Expected: Codex works with `OPENAI_API_KEY` absent, via login/subscription auth.

## 3. Create Project And Thread

- [ ] **Manual** In the UI, create a project with label `Verify Slice` and host
  path `$VERIFY_REPO`.
- [ ] If testing by REST, create the project:
  `curl -fsS -X POST http://127.0.0.1:8787/api/projects -H 'content-type: application/json' -d "{\"label\":\"Verify Slice\",\"hostPath\":\"$VERIFY_REPO\"}"`.
- [ ] Capture the returned project id as `PROJECT_ID`.
- [ ] **Manual** In the UI, create a Codex thread titled `Verify first turn`.
- [ ] If testing by REST, create the thread:
  `curl -fsS -X POST "http://127.0.0.1:8787/api/projects/$PROJECT_ID/threads" -H 'content-type: application/json' -d '{"title":"Verify first turn","engine":"codex"}'`.
- [ ] Capture the returned thread id as `THREAD_ID`.

Expected: project and thread appear in the UI and via `GET /api/projects`,
`GET /api/projects/:id/threads`, and `GET /api/threads/:id`.

## 4. First Message Starts A Fresh Codex Session

- [ ] Open the thread stream before or immediately after sending the message:
  `curl -N "http://127.0.0.1:8787/api/threads/$THREAD_ID/stream"`.
- [ ] **Manual** Send this first message from the UI:
  `Inspect the repo, create PONDEROSA_VERIFY.md with a one-line verification note, run git diff -- PONDEROSA_VERIFY.md, and summarize what you changed.`
- [ ] If testing by REST:
  `curl -fsS -X POST "http://127.0.0.1:8787/api/threads/$THREAD_ID/messages" -H 'content-type: application/json' -d '{"text":"Inspect the repo, create PONDEROSA_VERIFY.md with a one-line verification note, run git diff -- PONDEROSA_VERIFY.md, and summarize what you changed."}'`.
- [ ] Confirm the send response reports `mode: "seed"` and a `runId`.
- [ ] **Manual** Watch the UI show human-facing text in Chat and execution detail
  in Tasks/Artifacts, not dumped wholesale into Chat.

Expected: SSE emits normalized events including `session`, `command` or
`tool_call`, `file_change`, `text`, and `turn_done`; the run completes without
API keys.

## 5. Confirm Event Log, Projections, And Artifacts

- [ ] Find the canonical log:
  `find "$PONDEROSA_DATA_DIR/projects" -path "*/$THREAD_ID/events.jsonl" -print`.
- [ ] Confirm the log exists and is append-only JSONL with increasing `seq`:
  `tail -n +1 "$PONDEROSA_DATA_DIR/projects/$PROJECT_ID/threads/$THREAD_ID/events.jsonl"`.
- [ ] Confirm it contains a `user_message`, `session`, and `turn_done` event.
- [ ] Confirm thread hydration returns projected data:
  `curl -fsS "http://127.0.0.1:8787/api/threads/$THREAD_ID"`.
- [ ] Confirm task projection:
  `curl -fsS "http://127.0.0.1:8787/api/threads/$THREAD_ID/tasks"`.
- [ ] Confirm artifact projection:
  `curl -fsS "http://127.0.0.1:8787/api/threads/$THREAD_ID/artifacts"`.
- [ ] **Manual** Open the `PONDEROSA_VERIFY.md` diff artifact in the UI and by REST:
  `curl -fsS "http://127.0.0.1:8787/api/threads/$THREAD_ID/artifacts/$ARTIFACT_ID"`.

Expected: `events.jsonl` is the richest source of truth; SQLite-backed API views
match the log-derived messages/tasks/artifacts; artifact content is retrievable.

## 6. Second Message Resumes The Same Codex Session

- [ ] Record the first `sessionId` from `events.jsonl`.
- [ ] **Manual** Send a second UI message:
  `Using the same session, answer with the branch name and last command you ran.`
- [ ] If testing by REST:
  `curl -fsS -X POST "http://127.0.0.1:8787/api/threads/$THREAD_ID/messages" -H 'content-type: application/json' -d '{"text":"Using the same session, answer with the branch name and last command you ran."}'`.
- [ ] Confirm the send response reports `mode: "continue"`.
- [ ] Confirm the new run resumes the same Codex session id or uses the stored
  session id as the resume target.

Expected: the server calls adapter `continue()`, not `seed()`, and does not resend
the entire thread as a fresh context packet.

## 7. Cancel

- [ ] **Manual** Send a deliberately long-running but safe message, such as a
  request to inspect several files and wait for confirmation before summarizing.
- [ ] Cancel from the UI while the run is active.
- [ ] If testing by REST:
  `curl -fsS -X POST "http://127.0.0.1:8787/api/threads/$THREAD_ID/cancel"`.
- [ ] Confirm the response reports cancellation and the SSE stream receives a
  terminal cancellation/error/done state rather than hanging.
- [ ] Confirm the thread can accept another message after cancellation.

Expected: the active Codex child process is aborted, the UI leaves the run in a
coherent state, and the thread is usable afterward.

## 8. SSE Disconnect And Reconnect

- [ ] Start a run that emits multiple events.
- [ ] Open an SSE client with curl:
  `curl -N "http://127.0.0.1:8787/api/threads/$THREAD_ID/stream"`.
- [ ] **Manual** Kill curl mid-run and note the last printed SSE `id`.
- [ ] Reconnect with that id:
  `curl -N -H "Last-Event-ID: $LAST_SEQ" "http://127.0.0.1:8787/api/threads/$THREAD_ID/stream"`.
- [ ] Confirm replay starts after the last seen sequence and then tails live.
- [ ] **Manual** Lock/unlock the phone during a live run and confirm the UI catches
  up without duplicate visible events.

Expected: reconnect replays missed `events.jsonl` entries by sequence and dedupes
already-seen events.

## 9. Server Restart Behavior

- [ ] Start a run and wait until at least one event is written to `events.jsonl`.
- [ ] **Manual** Stop the server process while the run is active.
- [ ] Restart the server with the same `PONDEROSA_DATA_DIR`.
- [ ] Confirm `GET /api/threads/$THREAD_ID` hydrates from disk and projections.
- [ ] Confirm a new message resumes from the persisted Codex session id when one
  was captured before restart; if no session id was captured, confirm the system
  fails clearly or starts a fresh session only by explicit design.
- [ ] Confirm SQLite can be rebuilt from logs, if a rebuild command exists. Until
  it does, manually verify that deleting SQLite is not part of the release pass.

Expected: canonical history survives restart because it is in `events.jsonl`;
projected UI state returns after server boot; no chat/task/artifact history is
lost.

## 10. Two Concurrent Threads

- [ ] Create a second thread in the same project titled `Verify concurrent turn`.
- [ ] Start a Codex run in both threads before either one finishes.
- [ ] Keep two SSE clients open, one per thread.
- [ ] Confirm each stream only receives its thread's events.
- [ ] Confirm each thread has exactly one active run, but both threads may run at
  the same time.
- [ ] Confirm each thread records its own session id and separate `events.jsonl`.

Expected: the one-active-run limit is per thread, not global.

## 11. Phone And PWA Checks

- [ ] **Manual** Reach the web app from the phone over the intended v1 network
  path, such as Tailscale, using the host and port exposed by the dev/prod server.
- [ ] **Manual** Create a project/thread or open the existing verification thread.
- [ ] **Manual** Send a short Codex message from the phone and watch the live
  stream update without touching the laptop.
- [ ] **Manual** Background the browser or lock the phone during the run, then
  return and verify SSE replay catches up.
- [ ] **Manual** Install/add the PWA to the home screen if the manifest/service
  worker are present, then reopen it and confirm the same thread state loads.
- [ ] **Manual** Confirm mobile layout keeps Chat human-readable and execution
  detail separated into Tasks/Artifacts.

Expected: the v1 success criterion is literally true from a phone: intent in,
agent work on the box, structured results back.

## 12. Pass/Fail Notes

Record for the release note:

- Date/time:
- Commit:
- Host OS:
- Node/pnpm/Codex versions:
- `PONDEROSA_DATA_DIR` used:
- Test repo path:
- Project id:
- Thread ids:
- First Codex session id:
- Subscription billing result:
- Failed or blocked checks:
- Follow-up fixes opened:
