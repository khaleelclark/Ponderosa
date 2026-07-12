# @ponderosa/core — CONTRACTS

The most leveraged code in the repo. Every other package codes **against** these
types. Nothing here changes without a matching `SPEC.md` edit (AGENTS.md). The
barrel (`.`) is pure and JSON-serializable; `./config` and `./logger` are Node-only
subpath exports kept out of the browser bundle.

## Agent lifecycle health projection

Manager-facing health uses the exhaustive `AgentLifecycleStatus` vocabulary:
`idle`, `running`, `waiting`, `blocked`, `compacting`, `cancelled`, `completed`,
and `failed`. The server projects it on demand at project and master-chat scope
from stable thread IDs, active runs, delegation records, durable queued deliveries,
and canonical task/error events. It uses no client inference, per-agent polling,
heartbeat messages, or communication-event persistence.

Seven states are currently observable. `compacting` is intentionally unavailable:
the compact endpoint performs a synchronous session-boundary reset and exposes no
durable or asynchronous compaction interval. Projecting that transition would
fabricate state. A future runtime event or bounded server operation lease can make
it representable.

Ordinary cancellation also has no durable lifecycle event today; `cancelled` is
authoritative for delegated agents through the delegation ledger. The projection
cannot preserve ordinary-thread cancellation across restart until that event exists.

## `events.ts` — the normalized event model (SPEC §5)

| Export | Role — must not change without a SPEC edit |
|---|---|
| `AgentEvent` | The discriminated union every engine maps its runtime stream into (inside `packages/engines` only). The single contract between engines and the server/UI. |
| `AgentEventType` | The `type` discriminants of `AgentEvent`. |
| `TaskStatus` | Status of a Tasks-pane execution unit. |
| `FileChangeKind` | `create \| edit \| delete` for `file_change` events. |
| `TokenUsage` | Optional token accounting on `turn_done`. |
| `StoredEvent` | One line of `events.jsonl`: `{ seq, ts, event }`. Canonical log record; `seq` is the SSE reconnect id. |

## `adapter.ts` — the engine abstraction (SPEC §5)

| Export | Role |
|---|---|
| `Adapter` | The one interface every engine implements. `seed()` starts a fresh session from `history: ChatMessage[]` + cwd (no packet); `continue()` resumes by `resumeSessionId`. |
| `EngineId` | Stable engine identifier (`"codex"`, `"claude"`). |
| `ChatMessage` | One human-facing turn (`role`, `text`, optional `createdAt`). Fed to `seed()`. |
| `ModelOption` / `EffortOption` | Selectable model / reasoning-effort entries. |

## Agent preset contracts

`AgentPresetDto` and its create/update requests define project-scoped reusable
roles. `CreateThreadRequest.presetId` is resolved by the server and represented on
`ThreadDto.presetSnapshot`; delegation accepts the same safe identifier without
accepting ownership fields. Guidance is snapshotted at spawn, not looked up during
later turns.
| `RunOptionsBase` / `ContinueOptions` / `SeedOptions` | Method option bags; `signal` wires cancellation to process kill. |
| `EngineAuthStatus` | Auth status surfaced by `/api/engines`. |

## `dto.ts` — REST DTOs (SPEC §8)

Cross the UI↔server boundary; JSON-serializable, no Node types. One DTO per SPEC §7
projection plus request/response bodies for every SPEC §8 endpoint:
`ProjectDto`, `CreateProjectRequest`; `ThreadDto`, `ThreadState`, `ThreadDetailDto`,
`CreateThreadRequest`, `UpdateThreadRequest`, `UpdateThreadMasterChatMembershipsRequest`;
`MessageDto`, `TaskDto`, `ArtifactDto`,
`ArtifactKind`, `ArtifactContentDto`; `SendMessageRequest`/`Response`,
`CancelResponse`; `EngineDto`; `FileEntryDto`, `FilesResponse`; `HealthDto`; and the
v2 (501-stubbed) `SwitchEngineRequest`, `SearchResultDto`, `SearchResponse`.

## `sse.ts` — the streaming wire contract (SPEC §8)

`SseEventEnvelope` (the `data:` JSON), `SseEventName` (`message`/`heartbeat`/`done`),
`SseHeartbeat`. The SSE `id:` line carries `seq` for `Last-Event-ID` reconnect.

## `communication.ts` — canonical communication contract

`CommunicationEvent` is the one immutable project-level record behind chat,
audit, and inbox projections. Its intent determines its structurally typed
audience; collaboration uses a non-empty tuple of stable agent IDs. Projection,
delivery, context-classification, and knowledge-promotion records reference the
event ID and never mutate the original communication. Projection visibility and
future-context eligibility are deliberately independent.

## `config.ts` / `logger.ts` — Node-only (subpath exports)

`loadConfig(env)` → `PonderosaConfig`; `defaultDataDir(env)`; `createLogger(opts)` →
`Logger`. Not re-exported from the barrel.

---

## Decisions recorded (where SPEC left a shape open)

1. **`TaskStatus` values** = `"running" | "waiting_approval" | "done"` — SPEC §2/§12
   name exactly these three; encoded as JSON-safe snake_case. Extend only via SPEC.
2. **`ChatMessage.role`** = `"user" | "assistant"` — Chat is human-facing intent only
   (SPEC §2). No `system` role in the chat history contract.
3. **Engine session ids are persistence detail, not a public DTO field.** `ThreadDto`
   exposes `activeEngine` + derived `state`, not internal session-storage columns
   (those live in the `threads` projection / `thread.json`, SPEC §7). Keeps the wire
   contract engine-agnostic (AGENTS.md invariant 2).
4. **`defaultDataDir`** = `~/.ponderosa` on all OSes (honoring `XDG_DATA_HOME` when
   set). Matches the systemd unit in SPEC §10 and the "one portable, greppable dir"
   property (SPEC §7).
5. **`ArtifactKind`** = `"diff" | "test_report" | "pr_summary" | "log"` — the four
   artifact types named in SPEC §2/§12.
6. **`SendMessageResponse.mode`** (`"seed" | "continue"`) added so the client can tell
   whether a turn started a fresh session or resumed — surfaces the SPEC §8 streaming
   branch without exposing session ids.
7. **`config`/`logger` are subpath exports, not in the barrel** — so `apps/web`
   importing core types never bundles `node:os`/`node:path`/`process`.
8. **Agent/master-chat membership is additive.** `ThreadDto.masterChatIds` is the
   complete ordered membership set; nullable `masterChatId` is the primary/home
   member retained for routing and backward compatibility. The PUT membership DTO
   replaces both atomically and the server rejects a primary outside the set or any
   cross-project room. One thread/session/event log serves every membership.

9. **Reactions are inert durable occurrences.** A reaction records one canonical
   actor (`manager` or an active member thread), message/channel identity, emoji,
   desired active state, actor-global idempotency key, and immutable occurrence
   ID. Reaction persistence and author-notification outcomes are separate. The
   notification outbox is rebuilt from the canonical reaction log and membership
   is revalidated when it is read. Recording a reaction must never start or
   continue a runtime, expand a mention, assemble a prompt, or create delegation
   work.
