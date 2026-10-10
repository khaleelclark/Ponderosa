# Hands-free Agent calls (preview)

Open **Voice input → Call Agent** in a live Chat or an Agent’s private composer. Select an Agent, then choose **Start hands-free call**. The visible disclosure explains that finalized spoken turns will send automatically as private Direct Messages to that locked Agent. Opening the dialog alone never captures or sends. Send or clear an existing draft before starting hands-free.

This foreground session alternates **Listening → Sending → Agent working → Speaking → Listening**. Recognition is noncontinuous: a browser `speechend` requests graceful stop, and a clean `end` settles the turn. Browsers without `speechend` can finish through their ordinary recognition `end`. Only nonempty final results are submitted; consumed result positions suppress duplicates. Interim text never submits. Empty/no-speech, permission denial, recognition start/settlement failures and playback failures pause automatic turns. No silence heuristic or always-listening guarantee is invented. The browser controls actual end-of-speech timing and may use its vendor’s remote recognition service.

The microphone is released before reply playback, and capture resumes only after the actual playback `end` callback and successful owned audio cleanup. **Interrupt / Talk now** stops playback and starts eligible capture immediately; it does not cancel accepted Agent work. Stale playback callbacks cannot restart capture. Automatic acoustic barge-in, echo cancellation and full duplex are not supported.

**Review / type instead** abandons capture while retaining final words for manual editing/sending. **Listen → Finish turn → review → Send turn** and typed turns remain available. Ordinary composer dictation and Read aloud retain their existing controls. Missing recognition allows typed input; missing synthesis leaves readable replies and requires deliberate next capture. **Stop speaking** disables automatic continuation. **Mute microphone**, background/pagehide, inaccessible surfaces, navigation, changed Chat scope, unavailable membership and unmount fence callbacks and release owned capture/playback/timers. Unmute, Resume, reconnect and foreground return do not automatically restart capture. **End call / Open Chat** discard unsent words; accepted canonical work continues. Existing Chat cancellation controls remain authoritative.

## Reply safety and latency ceiling

Each automatic turn uses the existing immutable single-recipient `user_dm` request, queue policy and idempotency key. Unknown acknowledgement disables automatic capture/new turns. Only deliberate **Retry same turn** in the still-mounted call can retry the exact retained payload/key; there is no automatic resend or replacement key. Reload/reopen cannot restore private words and requires Chat review. Existing text-free marker, fingerprint, product/origin/Project/Chat/Agent identity, instance hint, expiry and lease/fence semantics remain unchanged. No new private-text storage is introduced.

Only the canonical, uniquely attributed authored reply for the accepted Communication’s exact processed/recovered delivery and execution may be spoken. Work logs, provider deltas, tools, unrelated replies, artifacts and Decisions never substitute for it. The existing latest-20-message and 120-second ceiling remains. Ambiguous/missing/failed attribution requires Chat.

The mounted reply observer shares the app’s existing authenticated workspace SSE → conversation-query invalidations. It adds no connection or transport. Its query includes the exact product path. A five-second read fallback covers missing/no event wakeups; actual nonabortable HTTP reads are shared until settlement so bursts cannot overlap reads. Late results cannot revive suspended/replaced calls. Full authored responses are required: there is no fake streaming speech.

The call shows this turn’s monotonic intervals: transcript settled → submission acknowledged as accepted → canonical reply observed → actual browser speech onset. These measure browser-observed events and include network, queue/scheduler and provider waits. Recognition finalization before settlement, complete playback duration, physical sound onset and end-to-end speech/provider latency are outside those segments. Synthetic fixture timings are separate test evidence, not live-provider latency claims.

## Verification and limits

Run the focused checks with the repository’s existing Node 24 / pnpm tooling and cached Playwright/Chromium:

```sh
node apps/web/test/voice-conversation-browser.check.mjs
node apps/web/test/speech-browser.check.mjs
node apps/web/test/voice-agent-detail-browser.check.mjs
```

Set `PONDEROSA_CHROMIUM_PATH` to an already-installed Chromium executable. For the first two helpers, `PONDEROSA_BROWSER_DISABLE_SANDBOX=1` is available on the existing managed Linux fixture host. No dependency or browser download is required. These tests use isolated disposable state and synthetic speech, never the operator preview microphone or provider account.

Physical devices qualified: **NONE**. Real microphone cessation, recognition accuracy/end timing, loudspeaker/Bluetooth echo, vendor STT/TTS, delayed autoplay, mobile/PWA/background audio focus, live subscription-provider latency and acoustic barge-in remain unqualified. Agents retain the host user’s filesystem/shell authority; the preview folder is not a sandbox. This change does not qualify native platforms, release/CI readiness, historical strict `<250 ms` gates or deployment. Independent review and a deliberate operator/device trial follow separately.
