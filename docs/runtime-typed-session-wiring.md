# Typed session input wiring

## Dependency and callable flow

Compose G6 a3173869d6b651fef5fd77badf3073c49e054658 and 801131d63da48e7a9fbb0a31942baf1448a3284d (base04e8) with G1/G4 bf54bc0e163e4a405e52eb47550e3785d69638d2. This branch contains the additive session wiring commit 7fe64d35489adde7d0ba6a40503d1da51fbc80fb and its framing successor. G2/G3 Codex and G8 Claude changes require ordinary hunk composition; no foreign checkout is edited.

G6 prepares original/digested descriptors, records exact prompt/source manifests, and rechecks current access and Run fence before submission. Codex startTurn and steer call codexTurnContent. Claude startTurn and steer forward inputFiles to writeInput and claudeTurnContent. Rendered seed prompt text remains unchanged. Native /compact passes no files. The shared serializers revalidate bytes and map images/PDF; unsupported audio and other formats retain original host prompt descriptors without invented native blocks.

## Bounded Claude media replay

The successor replaces the earlier 3 MiB input refusal. Replay-user-messages is retained because exact compact UUID acknowledgement depends on it. Only submitted image/document frames reserve a replay slot, before stdin write; failed writes forget it. Slots hold UUID, message SHA-256 and byte limit, never base64. There are at most 32 outstanding slots. Each admitted serialized frame plus 1 MiB envelope allowance must fit 224 MiB (the 160 MiB shared original/derived budget plus base64 expansion and bounded prompt/envelope headroom).

The existing single stdout reader uses ClaudeReplayFraming. Its line buffer expands only while an expected media echo exists, to that bounded outstanding frame allowance. Every unrelated record still has the existing 4 MiB acceptance limit. Large lines are staged transiently to validate their envelope; this can consume up to 224 MiB for one line, and JSON parsing/serialization adds transient memory. The transport does not promise constant-space streaming or arbitrary provider envelope support.

An echo is stripped only when type user, isReplay true, current session, exact input UUID, no parent tool use, exact submitted message digest (object key ordering normalized) and recorded byte limit match. The resulting event contains only receipt identity and empty user content. A mismatched expected replay refuses; an oversized unknown/foreign/duplicate replay refuses. Ordinary tool_result user frames are left intact under the existing output limit. Compact input/replay uses the original normal-limit path and preserves its receipt fields. No media reaches the downstream event mapper via a matched replay; no logging of payloads is added. Parser exit clears outstanding slots; slot exhaustion and envelope overflow fail visibly.

## Deferred qualification

Physically source-read session wiring, framing helper, documentation and deferred fixture. Fixture covers fragmented large exact replay, Unicode, preservation of adjacent tool_result, unrelated/foreign/mismatched/repeated refusal and compact text-only construction. No tests/checks/builds/types/Node/provider/browser execution, preparation, install, push or deploy. Pinned/native echoed message-envelope compatibility, memory pressure at the 160 MiB maximum, fresh/resumed/steered whole flows, cancellation and real original/artifact access revocation still need combined execution. Source wiring is complete for these paths; installed compatibility, full modality parity and Phase 2 acceptance are not claimed.

## Current input admission correction

Claude validates the complete typed frame before consuming initial history or
opening task lifetime. If a model control is needed, it rechecks the current Run
and validates the frame again after the acknowledgement. Local validation failure
keeps the initial history. Start and steer check current authority immediately
before input; unsupported native actions refuse rather than become ordinary text.
The scheduler's steering caller now supplies that callback with the exact original
Run, session, prompt injection, lease, pause state and current attachment access.
A failed or uncertain transport write is not permission to replay the source.
