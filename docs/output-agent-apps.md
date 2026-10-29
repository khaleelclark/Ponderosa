# Output apps and Assistant — first vertical slice

In a persistent Branch Agent's Settings, turn on **Output app** and choose
**Open output app**. Its stable local URL is `/apps/<agent-id>`. The page uses
the existing Agent chat, attachment, voice, browser, and stream components;
authoring and history remain in their existing canonical stores. Temporary
execution Agents cannot be output agents.

The output app's top **Settings** opens schedule and provider/model controls.
**Save schedule** publishes an interval schedule behind the app, with a workflow
version check, preserving its busy policy. An unchanged interval keeps its cadence. **Run automatically** controls that trigger. Cadence is at least
one minute; event-triggered workflows require **More options** rather than
silently replacing their event source. **Save model** uses the existing Agent
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
