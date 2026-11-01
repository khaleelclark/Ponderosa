# Current-turn typed input

Ponderosa carries authorized current attachments and explicitly referenced managed artifacts in `RuntimeTurnInput.inputFiles`. This is an input transport seam behind `Adapter`, not a provider HTTP client, credential store, upload endpoint, permission grant, or historical-media replay mechanism.

The UI continues to send ordinary attachment/artifact identities through its existing Chat, Agent, output-agent and Assistant communication routes. It must retain the original attachment and its download action. An image preview is a separately digested representation, never an original replacement. Voice recording/transcription remains the existing explicit voice flow; a transcript or file path must not be described as native audio understanding.

## Callable flow

- `prepareAgentRun` resolves current attachments through managed content verification, keeps their originals, and selects explicitly referenced artifacts only after `agentCanReadProjectArtifact`. It records `inputFiles` in the V3 provider-input source manifest and the exact prompt metadata. The prepared DTO travels through `agent-message-run` to `provider-run-executor` and both fresh/continued `startTurn` calls.
- Steering compiles the same descriptor shape before `preparePromptInjection`. Its source manifest records the descriptors alongside exact injection text. `dispatchSteering` forwards them to `RuntimeSession.steer`.
- Both paths recheck current recipient ownership/artifact access and current original digests immediately before the existing fenced `markPromptSubmitted` boundary. Recovery reuses the recorded descriptors, then rechecks access; it does not synthesize new media from old text. Historical manifests without typed descriptors retain their historical text-only behavior.
- `packages/engines/src/typed-input.ts` supplies `codexTurnContent(input, renderedPrompt?)` and `claudeTurnContent(input, renderedPrompt?)` to provider session owners. These preserve the exact submitted text unchanged and add native media blocks. The original descriptor already appears in the host prompt, so unsupported media do not introduce unrecorded fallback text.
- Native input serialization verifies each original and selected representation from an opened no-follow file descriptor against its admitted byte length/SHA-256. Invalid, changed or over-budget files fail before native content construction. No arbitrary authored URL or path is accepted as a typed input grant.

## Modality matrix

| Input | Codex app-server | Claude streaming input | Original and remaining limits |
| --- | --- | --- | --- |
| Text | Existing text input | Existing text block | Exact prompt/hash unchanged |
| PNG/JPEG/WebP/GIF | `localImage` | Base64 `image` | Original digest/path retained; existing preview policy may choose a PNG representation |
| HEIC/AVIF or oversized image | Verified existing PNG preview as `localImage` | Verified existing PNG preview as `image` | Original separately retained; this does not claim animation or all-frame parity |
| PDF | Original-file reference for native tools | Base64 `document` | Codex RPC documentation supplies no PDF item; encrypted/page/model limits remain provider errors |
| Audio recording | Original-file reference | Original-file reference | No invented native audio wire type; existing transcript/voice flow is distinct |
| Text/JSON/ZIP/DOCX/other file | Original-file reference | Original-file reference | Native tools may inspect originals; no claim of typed document/image understanding |
| Explicit current managed image/PDF | Same media mapping after current Agent access check | Same media mapping after current Agent access check | Private inaccessible IDs are never materialized; references do not expand access |
| Historical attachment or artifact | Existing bounded history references | Existing bounded history references | No automatic media replay from retained context |

The established 160 MiB runtime attachment budget includes originals and selected derived bytes. This is a host memory/stability bound, not a model-token count. Existing text-context estimates do not measure image/PDF tokens; provider capacity and payload failures remain explicit errors. Native sessions without typed-input transport must refuse a media-bearing submission rather than silently dropping its DTO.

## UI and integration contract

No new upload or permission UI is required. Existing send/queue/steer actions keep their canonical routing and Run fences. The inspector receives descriptor-only `sourceManifest.inputFiles`, including source Communication/Activation IDs, original media type, path, byte length and digest, plus any derived image's separate identity. These descriptors are audit data, not instructions or evidence that a model successfully understood the media. Raw base64 must stay inside provider stdin, never Ponderosa Communication, event summaries, source manifests or exports of execution logs.

Codex strengthened session wiring validates files before plan settings and again after acknowledgement, retains seed history on validation failure, checks optional Run authority around steer billing/dispatch and rejects native review attachments explicitly; see [Codex wiring](codex-typed-input-wiring.md). Provider session integration is wired: both `startTurn` and `steer` call the relevant serializer; native command input stays text-only. Claude retains replay-user-messages. The framing successor replaces the earlier 3 MiB refusal: exact expected media echoes validate current session, UUID and normalized submitted-message digest, then strip media before downstream mapping. The echo allowance is submitted size +1 MiB, at most224 MiB, with32 outstanding digest-only slots. Unrelated records keep the4 MiB limit; tool_result records remain intact. Failed writes/parser exit forget reservations. This bounded transient buffering is not constant-space streaming or an arbitrary provider-envelope guarantee. See [session wiring](runtime-typed-session-wiring.md). Maximum-size memory pressure and installed compatibility remain unqualified.

## Deferred verification

`packages/engines/test/typed-input.test.mjs` covers native image shapes, Claude PDF versus Codex file reference, original audio references, derived-original integrity, source provenance and the byte budget. It is authored for later execution after the coordinated build. `apps/server/test/runtime-input-files.test.mjs` adds private-access denial, current revocation, exact recipient provenance and descriptor-only context fixtures. Neither file has been run in this change.

The final combined verification still needs package typechecks/builds; real fresh/resumed/steered Core and Branches deliveries; PDF and large-image CLI compatibility; lost-access/fence/cancel/recovery cases; original and preview downloads; descriptor-only UI audit rendering; no raw-media echo in logs; and existing voice/transcription behavior. No harness parity, accessibility or Phase 2 acceptance is inferred from source alone.

Official schemas read for this implementation:

- [Codex app-server turns](https://learn.chatgpt.com/docs/app-server#turns): text, image URL, and localImage input items. Ponderosa uses only its validated local copies.
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): user content arrays and base64 image blocks.
- [Claude PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support): base64 PDF document blocks. This documents the content shape; installed CLI acceptance remains a deferred integration gate.
