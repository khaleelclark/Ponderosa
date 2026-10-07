# Beta12 voice conversation development

The first development preview adds Talk to an existing Chat with at least one
Agent. Select the Agent explicitly, tap Listen, review the recognized text, and
send the turn. The Agent's completed reply is read aloud using
browser speech. Tap Listen to continue.
This preview is turn-based; automatic end-of-turn sending and automatic microphone
reactivation are intentionally not enabled until real-device qualification.

Voice turns use the existing direct-message intake, stable Agent IDs, an
idempotency key retained for retries within the open session, and queued delivery. They use the selected
Agent's saved runtime configuration. There is no new provider, API-key path,
communication log, or scheduler. Replies follow the accepted direct message’s canonical delivery receipt and exact
completed execution ID. Only one matching direct reply from the selected Agent in
the same Chat is read; ambiguous or artifact-backed replies return to Chat.
Background messages, provider output and historical replies are never speech input.

Pause, hidden surfaces, navigation and End session stop capture/playback. Ending a
session does not cancel an already-sent request. Questions, failed outcomes,
truncated replies and a two-minute wait return the user to ordinary Chat. Sending
requires a visible transcript review. Speech recognition remains browser-dependent.

Before treating this as a Beta12 release feature, qualify microphone permission,
actual recognition, speaker echo, browser autoplay, interruption, backgrounding,
reconnect, long replies and delivery failures on real Mac and phone browsers.
Add automatic listening only after these checks support it. True simultaneous
speech/interruption and background phone-call behavior remain future work.
Windows and Claude execution tests deferred for Beta11 are not carried forward as
passing evidence. No Beta12 release or production deployment is implied.

Unsent text and ambiguous retry identity are currently session-local. End or reload
discards them; check Chat before resending an unconfirmed turn in a new session.

The latest 20-message page must still include the accepted voice turn. If Chat
activity pushes it outside that window, voice pauses instead of treating a partial
history sample as a unique reply. This is the initial bounded-history ceiling.
