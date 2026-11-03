# Output apps and Assistant — first vertical slice

In a persistent Branch Agent's Settings, turn on **Output app** and choose
**Open output app**. Its stable local URL is `/apps/<agent-id>`. The page uses
the existing Agent chat, attachment, voice, browser, and stream components;
authoring and history remain in their existing canonical stores. Temporary
execution Agents cannot be output agents. Opening an output URL or Assistant, and
using **Back to chat**, explicitly selects the output Agent’s chat view rather
than restoring a tab previously visited in the full workspace.

The output app's top **Settings** opens schedule and provider/model controls.
**Run automatically**, applied with **Save schedule**, enables or pauses the
existing trigger without replacing its source or cadence. This also works for
cron, one-time, filesystem and webhook triggers; their trigger type or schedule summary is
shown instead of an interval editor. Turning automatic runs on also enables the
workflow. Re-enabling a paused trigger validates its configuration and shows any error.

For manual workflows and existing interval schedules, **Check every (minutes)**
is editable, with a minimum of one minute. Enabling automatic runs on a manual
workflow creates an interval schedule; changing an interval publishes the new
cadence while preserving its busy policy. An unchanged interval keeps its cadence.
Saves check the workflow version and output-settings revision and report conflicts.
Use **More options** to change other trigger configuration.
**Save model** uses the existing Agent
runtime settings endpoint and validation; it changes the bound Agent without
changing identity or history. Schedule and model saves are independent actions.
**More options** opens the owning workflow in Branches.

Opening the normal Ponderosa workspace initializes the default Assistant once,
through the existing tracked Chat creation and Agent package import paths.
`/assistant` also initializes a not-yet-initialized installation. If no provider
is available, the UI displays the actual creation error and Retry/Enable remains
available. The default Branch workflow checks every ten minutes and uses the
chosen provider's saved model/effort defaults. Provider billing/auth behavior is
unchanged. No new provider call is needed just to create the idle Assistant.

**Ponderosa speaker** is a local installation role. Exactly one live persistent
Branch Agent can hold it. Remove the previous speaker role before assigning
another; removing the role pauses its trigger and existing output apps remain usable. Model, prompt and title edits do
not remove the role. Deletion, unavailable ownership, or role removal makes
Assistant disabled. Ordinary initialization never recreates a removed speaker.
Explicit **Enable Assistant** creates a fresh default only if no live speaker
exists. Existing workflows and user files are retained. **Disable Assistant**
pauses its current workflow's trigger before clearing the role; it does not
cancel already accepted work. Workflow trigger settings remain visible in
Branches.

Output designations, the singleton speaker pointer and a resumable default-setup
receipt are stored in the canonical workspace preferences journal. Generic
preferences PATCH cannot write these role fields; dedicated role routes validate
current ownership. Setup pins its import timestamp/model/effort and idempotency
keys so a retry cannot substitute a different import. A disable during setup
prevents later designation; any created user-owned resources remain for review.
Portable packages can declare output/speaker intent using included logical refs.
Server-backed import review controls whether that intent is activated; local
pointers, setup state and access grants are never transported. Existing speakers
are preserved and collision dialogs leave imported speaker intent inactive while
retaining eligible outputs. Core Chat imports disclose inactive roles. See
[portable output roles](portable-output-roles.md) for review and recovery rules.

The existing cross-Ponderosa message UI is labeled **Inbox**, including navigation,
page titles, accessibility labels and composer hint. Its existing `/messages`
route remains the stable browser entry point. Internal components, route kind,
DTOs, query keys, transport endpoint and projection methods now use Inbox names.
Persisted `all_chat_feed` index names remain stable storage identifiers.

## Controlled qualification

After build, run:

```sh
TMPDIR=/tmp node --import ./tests/shared/workspace-resolution.mjs --test --test-concurrency=1 tests/branches/api.test.mjs tests/branches/schedule-overlap.test.mjs
TMPDIR=/tmp node --import ./tests/shared/workspace-resolution.mjs tests/branches/output-app-ui-qualification.mjs
```

The second command uses installed headless Chrome at `/opt/google/chrome/chrome`
(or `PONDEROSA_BROWSER_EXECUTABLE`), owned loopback servers and inert provider
processes. It first opens the fresh normal workspace and verifies automatic Assistant initialization, then sends a real UI message and observes its explicit reply, saves
schedule/model settings, checks the persisted workflow interval and captures
desktop/settings/phone screenshots under `/tmp/ponderosa-output-app-ui` (override
with `PONDEROSA_OUTPUT_QUALIFICATION_DIR`). It installs nothing and uses no account
or paid inference. Fixtures close browser/server/provider processes.

## Remaining Build-list acceptance

This is a working first slice, not full Build-list or whole-Bible completion.
The shell still exposes the existing Agent/Chat controls; iOS Messages/phone visual
parity, blind judging, every surface's streaming polish, real voice-message/call
qualification and time-to-first-audio remain pending. Cross-project create/start
and deterministic scheduled completion/issue reports now have controlled-provider
coverage in [Assistant workspace actions](assistant-workspace.md). This does not
establish real-provider report quality or grant new memory/browser access.

The scheduler catch-up fix is separately frozen on `phase2/branches-first-batch`;
this slice starts from ui097 `c581d406604d9cec7fee69cb5e118ce024285d95` and does not
include or modify those commits. Integration through Cliff remains required.

Working-file links from `/assistant` and `/apps/<agent-id>` open the Branches file viewer in a new tab. The standalone shell supplies its canonical Branch/Chat owner; the nested workspace URL retains the file’s Agent or Chat owner, exact path and fragment. File-preview Markdown links and shared resource links use the same product navigation helper. Ordinary Core workspace links retain their original URLs.

## Everyday controls

Output URLs use a focused chat header; workflow editing and organization controls
remain under **More options**. **Settings** offers the automatic interval, provider
and model, appearance, and the Assistant enable/disable action. Opening settings
loads the current workflow values. Background refreshes retain an open draft;
a schedule save sends the currently observed workflow version and displays any
conflict rather than silently replacing newer edits. The interval must be finite,
at least one minute, and represent an exact safe millisecond value.

General workspace settings also show whether Assistant is enabled. Explicitly
re-enabling uses the canonical Assistant endpoint; the UI does not create a second
workflow locally. Speaker/output toggles serialize writes and retain the observed
speaker role when changing only the output designation.

Text size is a device preference, shared by Core, Branches, Assistant, and output
URLs through browser storage. Available sizes are 100–200%; browser zoom remains
available. Font family uses the existing workspace preference. Standalone chat
uses the same visual-viewport keyboard handling as the full workspace.

## Voice messages

**Voice options → Record voice message** opens the browser microphone recorder.
Finish, review the audio, and choose **Attach voice message**. It enters the same
draft upload queue as a selected file; the ordinary Send action sends it to the
selected recipient. It is never sent automatically. Attachment limits still apply;
a rejected attachment stays in the recording dialog for review and retry. Discard is explicit. Recording stops when its surface becomes
inactive, and microphone tracks are released on finish, failure, replacement, or
unmount. Draft and sent audio attachments have native playback controls.

Recording requires browser MediaRecorder and microphone access. The browser chooses
among Opus/WebM, MP4, and Opus/Ogg; unsupported browsers keep dictation and file
attachment options. Audio remains an attachment; no new transcription service,
provider transport, or credentials store is introduced. Server asset admission must
preserve the matching validated audio media type for playback after reload.

These implementation changes have not been built, typechecked, browser exercised,
or qualified under the implement-first direction. Previous qualification evidence
is historical and does not qualify these changes.

## Shared text and save feedback

The text-size preference also scales the shared body text, chat authors, live
progress, composer text and mention tokens. The iOS composer keeps a minimum
one-rem text size at the default setting to avoid focus zoom; increasing the
preference scales its text and line height together. The input remains scrollable
within its existing height bound. Navigation labels and sidebar search follow
the same preference; the search control can grow with its text.

Output and Assistant Settings announce **Saving…**, then **Schedule saved** or
**Model saved** only after the corresponding write and settings readback succeed.
Changing a draft or moving the Assistant speaker clears earlier feedback. Late
completions from an earlier owner cannot publish feedback for the new owner,
even if the speaker subsequently moves back. Unmounting invalidates publication.
Schedule and model remain independent saves with globally serialized writes.
A successful write followed by a failed readback instead reports **Changes saved,
but settings could not be refreshed**, with the readback cause inside Settings.
Drafts remain available; this warning does not mean the write failed. Retry reads
settings only and never repeats the mutation automatically. Mutation errors also
retain the draft and do not become a saved acknowledgement. The status row
reserves its line height so that feedback does not move the controls.

Live Agent response prose and completed Markdown use shared responsive font sizes
and line heights, including compact Work output. Completion still promotes literal
stream text into Markdown; formatting can change its structure. This removes the
font-size switch, not every possible layout change from authored Markdown.

These source changes have not been tested, built, typechecked or browser exercised
under the current implementation-first direction. Reader/keyboard behavior,
font layout, visual comparison, streaming recordings and call latency remain
combined-product validation work; no whole-commandment acceptance is implied.
